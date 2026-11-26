const {
  getWriteSheetsClient,
  buildTransactionRow,
  dateToSerial,
  getHeaderMap,
  columnLetter,
  upsertPayee,
  getSheetGridId,
  fetchPayeeRows,
  writeTransactionKind,
  fetchTransactionRows,
  ensureTransactionsColumns,
  fetchCategoryContext,
  writeTransactionCategory,
} = require('./_lib/sheets');
const { categoryForSave, categoryCells, planBulkCategory, CATEGORY_COLUMN, CATEGORY_RULE_COLUMN } = require('./_lib/categories');
const { kindForSave, planBulkKind, payeeKindMap, normalizeBillId, KIND_COLUMN, KIND_RULE_COLUMN, BILL_ID_COLUMN } = require('./_lib/kinds');
// Shared with the browser bulk bar so the confirm text and the server agree.
const { canMatch, pickKeeper, resultingBillId } = require('../public/shared/txn-match.js');

// Bulk "Set kind" (shared/kind-ui.js): { action: 'setKind', rowNumbers,
// kind: 'Variable' | 'Fixed' | 'auto' }. Touches only Kind / Kind Rule --
// no other cell, no Pending flip (unlike a full save, setting a Kind isn't
// reviewing the row). One read of the tab, one batch write. Income and
// Transfer rows are skipped and counted, see planBulkKind().
async function setKindBulk(body) {
  const rowNumbers = Array.isArray(body.rowNumbers) ? body.rowNumbers : [];
  if (!rowNumbers.length) {
    const err = new Error('Missing required field: rowNumbers');
    err.status = 400;
    throw err;
  }
  const sheets = getWriteSheetsClient();
  const spreadsheetId = process.env.SHEET_ID;
  const [rows, payees, headerMap] = await Promise.all([
    fetchTransactionRows(),
    fetchPayeeRows(sheets),
    getHeaderMap(sheets, spreadsheetId, 'transactions'),
  ]);
  let plan;
  try {
    plan = planBulkKind(rows, rowNumbers, body.kind, payeeKindMap(payees));
  } catch (e) {
    e.status = 400;
    throw e;
  }
  if (plan.writes.length) {
    const map = await ensureTransactionsColumns(sheets, headerMap, [KIND_COLUMN, KIND_RULE_COLUMN]);
    const kindCol = columnLetter(map[KIND_COLUMN]);
    const ruleCol = columnLetter(map[KIND_RULE_COLUMN]);
    const data = [];
    plan.writes.forEach((w) => {
      data.push({ range: `transactions!${kindCol}${w.rowNumber}`, values: [[w.kind]] });
      data.push({ range: `transactions!${ruleCol}${w.rowNumber}`, values: [[w.rule]] });
    });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data },
    });
  }
  return {
    ok: true,
    updated: plan.writes.length,
    skipped: plan.skipped.length,
    missing: plan.missing.length,
    rows: plan.writes,
    updatedAt: new Date().toISOString(),
  };
}

// Bulk "Set category" (shared/category-ui.js): { action: 'setCategory',
// rowNumbers, category: '<name>' | 'auto' }. Touches only Category /
// Category Rule -- no other cell, no Pending flip. Transfers and rows the
// category doesn't fit (an expense category on income) are skipped and
// counted, see planBulkCategory().
async function setCategoryBulk(body) {
  const rowNumbers = Array.isArray(body.rowNumbers) ? body.rowNumbers : [];
  if (!rowNumbers.length) {
    const err = new Error('Missing required field: rowNumbers');
    err.status = 400;
    throw err;
  }
  const sheets = getWriteSheetsClient();
  const spreadsheetId = process.env.SHEET_ID;
  const [rows, ctx, headerMap] = await Promise.all([
    fetchTransactionRows(),
    fetchCategoryContext(sheets),
    getHeaderMap(sheets, spreadsheetId, 'transactions'),
  ]);
  let plan;
  try {
    plan = planBulkCategory(rows, rowNumbers, body.category, ctx);
  } catch (e) {
    e.status = 400;
    throw e;
  }
  if (plan.writes.length) {
    const map = await ensureTransactionsColumns(sheets, headerMap, [CATEGORY_COLUMN, CATEGORY_RULE_COLUMN]);
    const catCol = columnLetter(map[CATEGORY_COLUMN]);
    const ruleCol = columnLetter(map[CATEGORY_RULE_COLUMN]);
    const data = [];
    plan.writes.forEach((w) => {
      data.push({ range: `transactions!${catCol}${w.rowNumber}`, values: [[w.category]] });
      data.push({ range: `transactions!${ruleCol}${w.rowNumber}`, values: [[w.rule]] });
    });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data },
    });
  }
  return {
    ok: true,
    updated: plan.writes.length,
    skipped: plan.skipped.length,
    missing: plan.missing.length,
    rows: plan.writes,
    updatedAt: new Date().toISOString(),
  };
}

// Category system C3: re-derives Category / Category Rule for a row that
// was just saved. Like rewriteKind() it reads the row's current Transfer,
// Source ID and stored category first, so a hand-set category survives the
// edit paths that never mention it (inline cell edits, swipe-to-clear,
// bulk actions); categoryManual true / false in the body sets / clears it.
// Only writes when the cells would change.
async function rewriteCategory(sheets, spreadsheetId, headerMap, rowNumber, row, body) {
  const [resp, ctx] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `transactions!A${rowNumber}:AZ${rowNumber}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    fetchCategoryContext(sheets),
  ]);
  const current = (resp.data.values && resp.data.values[0]) || [];
  const cell = (name) => {
    const idx = headerMap[name];
    const v = idx === undefined ? '' : current[idx];
    return v === undefined || v === null ? '' : v;
  };
  const transferRaw = cell('Transfer');
  const isTransfer = transferRaw === true || transferRaw === 'TRUE' || transferRaw === 'true';
  const billId = Object.prototype.hasOwnProperty.call(body, 'billId')
    ? (normalizeBillId(body.billId) || '')
    : String(cell(BILL_ID_COLUMN)).trim();
  const stored = { storedCategory: String(cell(CATEGORY_COLUMN)).trim(), storedCategoryRule: String(cell(CATEGORY_RULE_COLUMN)).trim() };
  const result = categoryForSave(
    { type: row[1], isTransfer, billId, notes: row[10], payee: row[0] },
    { category: body.category, categoryManual: body.categoryManual },
    stored,
    ctx,
  );
  const cells = categoryCells(result);
  const unchanged = headerMap[CATEGORY_COLUMN] !== undefined && headerMap[CATEGORY_RULE_COLUMN] !== undefined &&
    stored.storedCategory === cells.category && stored.storedCategoryRule === cells.rule;
  if (!unchanged) await writeTransactionCategory(sheets, headerMap, rowNumber, cells);
  return result;
}

// WS1: re-derives and writes Kind / Kind Rule (and Source ID, when the
// request links or unlinks a bill) for a row that was just saved. Reads the
// row's current Transfer / Kind / Source ID first, so a hand-set Kind or a
// bill link survives the many edit paths that never mention them (inline
// cell edits, swipe-to-clear, bulk actions).
async function rewriteKind(sheets, spreadsheetId, headerMap, rowNumber, row, body) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `transactions!A${rowNumber}:AZ${rowNumber}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const current = (resp.data.values && resp.data.values[0]) || [];
  const cell = (name) => {
    const idx = headerMap[name];
    const v = idx === undefined ? '' : current[idx];
    return v === undefined || v === null ? '' : v;
  };
  const transferRaw = cell('Transfer');
  const isTransfer = transferRaw === true || transferRaw === 'TRUE' || transferRaw === 'true';
  const linkRequested = Object.prototype.hasOwnProperty.call(body, 'billId');
  const billId = linkRequested ? (normalizeBillId(body.billId) || '') : String(cell(BILL_ID_COLUMN)).trim();
  const payeeKinds = payeeKindMap(await fetchPayeeRows(sheets));
  const result = kindForSave(
    { type: row[1], isTransfer, billId, notes: row[10], payee: row[0] },
    { kind: body.kind, kindManual: body.kindManual },
    { storedKind: String(cell(KIND_COLUMN)).trim(), storedRule: String(cell(KIND_RULE_COLUMN)).trim() },
    payeeKinds,
  );
  await writeTransactionKind(sheets, headerMap, rowNumber, { ...result, billId: linkRequested ? billId : undefined });
  return result;
}

// Issue #51: finds every row on `transactions` currently stamped with
// `matchId` (self-provisioned "Match ID"/"Match Status" columns -- see
// EmailImport.gs). Returns null if the sheet has no Match ID column at all
// (nothing to resolve). Used by both confirmMatch and unmatchMatch below.
async function findMatchRows(sheets, spreadsheetId, headerMap, matchId) {
  if (headerMap['Match ID'] === undefined) return null;
  const matchIdCol = headerMap['Match ID'];
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'transactions!A2:AZ',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = response.data.values || [];
  const pendingCol = headerMap['Pending'];
  const rows = [];
  values.forEach((row, i) => {
    if (String(row[matchIdCol] || '').trim() !== String(matchId).trim()) return;
    const pendingRaw = pendingCol !== undefined ? row[pendingCol] : undefined;
    const isPending = pendingRaw === true || pendingRaw === 'TRUE' || pendingRaw === 'true';
    rows.push({ rowNumber: i + 2, isPending });
  });
  return rows;
}

// Clears the Match ID / Match Status columns (blank, not deleted) on every
// row number given -- used to detach rows from a resolved match without
// touching anything else about them.
async function clearMatchColumns(sheets, spreadsheetId, headerMap, rowNumbers) {
  const matchIdCol = columnLetter(headerMap['Match ID']);
  const data = rowNumbers.map((rowNumber) => ({
    range: `transactions!${matchIdCol}${rowNumber}`,
    values: [['']],
  }));
  if (headerMap['Match Status'] !== undefined) {
    const matchStatusCol = columnLetter(headerMap['Match Status']);
    rowNumbers.forEach((rowNumber) => {
      data.push({ range: `transactions!${matchStatusCol}${rowNumber}`, values: [['']] });
    });
  }
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });
}


const truthy = (v) => v === true || v === 'TRUE' || v === 'true';

// See the `matchRows` action below. Returns { status, body }.
async function matchRows(body) {
  const nums = Array.isArray(body.rowNumbers) ? body.rowNumbers.map((n) => parseInt(n, 10)) : [];
  if (nums.length !== 2 || nums.some((n) => !Number.isInteger(n) || n < 2)) {
    return { status: 400, body: { error: 'rowNumbers must be exactly 2 sheet row numbers.' } };
  }

  const sheets = getWriteSheetsClient();
  const spreadsheetId = process.env.SHEET_ID;
  const headerMap = await getHeaderMap(sheets, spreadsheetId, 'transactions');
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'transactions!A2:AZ',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = resp.data.values || [];
  const cellOf = (row, name) => {
    const idx = headerMap[name];
    const v = idx === undefined ? undefined : row[idx];
    return v === undefined || v === null ? '' : v;
  };
  const toTxn = (rowNumber) => {
    const row = values[rowNumber - 2];
    if (!row || !row[0]) return null;
    return {
      rowNumber,
      raw: row,
      payee: row[0],
      type: row[1] === 'Income' ? 'Income' : 'Expense',
      amount: parseFloat(row[6]) || 0,
      cleared: String(row[5] || '').trim(),
      notes: row[10] || '',
      pending: truthy(cellOf(row, 'Pending')),
      reconciled: truthy(cellOf(row, 'Reconciled')),
      billId: String(cellOf(row, BILL_ID_COLUMN)).trim() || null,
      paymentId: String(cellOf(row, 'Payment ID')).trim() || null,
      matchId: String(cellOf(row, 'Match ID')).trim() || null,
    };
  };

  const a = toTxn(nums[0]);
  const b = toTxn(nums[1]);
  if (!a || !b) return { status: 404, body: { error: 'One of those rows no longer exists. Refresh and try again.' } };
  const check = canMatch(a, b);
  if (!check.ok) return { status: 400, body: { error: `Can't match: ${check.reason}` } };

  const { keep, drop } = pickKeeper(a, b);
  if (drop.reconciled) {
    return { status: 400, body: { error: `Can't match: "${drop.payee}" is already reconciled, so it can't be deleted. Undo that reconciliation first.` } };
  }
  if (drop.paymentId) {
    return { status: 400, body: { error: `Can't match: "${drop.payee}" is one leg of a card payment. Undo the payment first.` } };
  }
  const billId = resultingBillId(a, b);

  // 1. The surviving row: reviewed (Pending FALSE), Cleared if either was,
  //    and no longer part of any proposed import match.
  const data = [];
  if (headerMap['Pending'] !== undefined) {
    data.push({ range: `transactions!${columnLetter(headerMap['Pending'])}${keep.rowNumber}`, values: [[false]] });
  }
  if (keep.cleared.toLowerCase() !== 'cleared' && drop.cleared.toLowerCase() === 'cleared') {
    data.push({ range: `transactions!F${keep.rowNumber}`, values: [['Cleared']] });
  }
  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data } });
  }
  const matchIds = [keep.matchId, drop.matchId].filter(Boolean);
  if (matchIds.length && headerMap['Match ID'] !== undefined) {
    const linked = [];
    values.forEach((row, i) => {
      const id = String(cellOf(row, 'Match ID')).trim();
      if (id && matchIds.includes(id) && i + 2 !== drop.rowNumber) linked.push(i + 2);
    });
    if (linked.length) await clearMatchColumns(sheets, spreadsheetId, headerMap, linked);
  }

  // 2. Bill link + Kind: a Source ID makes the row Fixed (see kinds.js).
  const kindResult = await rewriteKind(
    sheets, spreadsheetId, headerMap, keep.rowNumber, keep.raw,
    billId ? { billId } : {},
  );

  // 3. Delete the other row last, so the writes above hit the right rows.
  const gridId = await getSheetGridId(sheets, spreadsheetId, 'transactions');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: gridId, dimension: 'ROWS', startIndex: drop.rowNumber - 1, endIndex: drop.rowNumber },
        },
      }],
    },
  });

  return {
    status: 200,
    body: {
      ok: true,
      keptRowNumber: drop.rowNumber < keep.rowNumber ? keep.rowNumber - 1 : keep.rowNumber,
      deletedRowNumber: drop.rowNumber,
      billId: billId || null,
      kind: kindResult.kind,
      updatedAt: new Date().toISOString(),
    },
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { rowNumber, payee, type, sof, date, month, cleared, amount, notes, action, lat, lon, updatePayeeLocation, matchId } = req.body || {};

    if (action === 'setKind') {
      try {
        res.status(200).json(await setKindBulk(req.body || {}));
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
      }
      return;
    }

    if (action === 'setCategory') {
      try {
        res.status(200).json(await setCategoryBulk(req.body || {}));
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
      }
      return;
    }

    // Issue #51: user declines a proposed match ("not the same transaction")
    // -- clears the Match ID/Status off every row sharing it (normally the
    // imported leg and the manual leg), leaving both rows otherwise
    // untouched and fully independent again. Graceful no-op if there's no
    // Match ID column yet, or nothing currently carries this matchId.
    if (action === 'unmatchMatch') {
      if (!matchId) {
        res.status(400).json({ error: 'Missing required field: matchId' });
        return;
      }
      const sheets = getWriteSheetsClient();
      const spreadsheetId = process.env.SHEET_ID;
      const headerMap = await getHeaderMap(sheets, spreadsheetId, 'transactions');
      const matchRows = await findMatchRows(sheets, spreadsheetId, headerMap, matchId);
      if (matchRows && matchRows.length) {
        await clearMatchColumns(sheets, spreadsheetId, headerMap, matchRows.map((r) => r.rowNumber));
      }
      res.status(200).json({ ok: true, updatedAt: new Date().toISOString() });
      return;
    }

    // Manual match: the user picked two rows in the bulk bar that are the
    // same real transaction (typically a bank-email import and the bill
    // row InstallmentsBills.gs auto-inserted for it). Keeps one row, moves
    // the bill link (Source ID) onto it, marks it reviewed (Pending FALSE),
    // and deletes the other -- so the Bills page sees the bill as paid.
    // Which row stays is decided by public/shared/txn-match.js, the same
    // rule the confirmation dialog used.
    if (action === 'matchRows') {
      const result = await matchRows(req.body || {});
      res.status(result.status).json(result.body);
      return;
    }

    // Issue #51: user confirms a proposed match ("yes, same transaction") --
    // in this MVP phase the auto-imported leg (Pending=true) is deleted
    // outright and the surviving manually-entered row has its Match ID/
    // Status cleared, going back to being a normal, unflagged transaction.
    // Mirrors deletePaymentRows' find-by-shared-ID-then-delete pattern in
    // api/_lib/reconcile.js. Graceful no-op if there's no Match ID column,
    // nothing currently carries this matchId, or (defensively) neither row
    // in the pair turns out to be the pending/imported leg.
    if (action === 'confirmMatch') {
      if (!matchId) {
        res.status(400).json({ error: 'Missing required field: matchId' });
        return;
      }
      const sheets = getWriteSheetsClient();
      const spreadsheetId = process.env.SHEET_ID;
      const headerMap = await getHeaderMap(sheets, spreadsheetId, 'transactions');
      const matchRows = await findMatchRows(sheets, spreadsheetId, headerMap, matchId);
      if (matchRows && matchRows.length) {
        const importedRows = matchRows.filter((r) => r.isPending);
        const survivingRows = matchRows.filter((r) => !r.isPending);

        if (importedRows.length) {
          const gridId = await getSheetGridId(sheets, spreadsheetId, 'transactions');
          // Highest row number first so deleting one doesn't shift the
          // row-number of another still waiting to be deleted.
          const toDelete = importedRows.map((r) => r.rowNumber).sort((a, b) => b - a);
          for (const rn of toDelete) {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId,
              requestBody: {
                requests: [{
                  deleteDimension: {
                    range: { sheetId: gridId, dimension: 'ROWS', startIndex: rn - 1, endIndex: rn },
                  },
                }],
              },
            });
          }
        }

        if (survivingRows.length) {
          await clearMatchColumns(sheets, spreadsheetId, headerMap, survivingRows.map((r) => r.rowNumber));
        }
      }
      res.status(200).json({ ok: true, updatedAt: new Date().toISOString() });
      return;
    }

    // Lightweight "confirm pending" action (issue #49) -- flips just the
    // Pending column to FALSE for one row (the "Pending -> Uncleared" step
    // in #38's four-stage lifecycle), without the caller having to resend
    // every other field the full update below requires. Pending is a
    // self-provisioned column (see EmailImport.gs / issue #38) that may not
    // exist yet on a sheet that's never run that script -- treated as a
    // graceful no-op (still 200 OK) rather than an error, since "no Pending
    // column" already means "nothing on this sheet is pending".
    if (action === 'confirmPending') {
      if (!rowNumber) {
        res.status(400).json({ error: 'Missing required field: rowNumber' });
        return;
      }
      const sheets = getWriteSheetsClient();
      const spreadsheetId = process.env.SHEET_ID;
      const headerMap = await getHeaderMap(sheets, spreadsheetId, 'transactions');
      if (headerMap['Pending'] === undefined) {
        res.status(200).json({ ok: true, updatedAt: new Date().toISOString(), note: 'No Pending column on this sheet yet.' });
        return;
      }
      const col = columnLetter(headerMap['Pending']);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `transactions!${col}${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[false]] },
      });
      res.status(200).json({ ok: true, updatedAt: new Date().toISOString() });
      return;
    }

    if (!rowNumber || !payee || !type || !sof || !date || !month || !cleared || amount === undefined || amount === null) {
      res.status(400).json({ error: 'Missing required field: rowNumber, payee, type, sof, date, month, cleared, amount are all required' });
      return;
    }

    const parsedAmount = parseFloat(amount);
    if (Number.isNaN(parsedAmount)) {
      res.status(400).json({ error: 'amount must be a number' });
      return;
    }

    const dateSerial = dateToSerial(new Date(`${date}T00:00:00Z`));
    const monthSerial = dateToSerial(new Date(`${month}-01T00:00:00Z`));

    const row = buildTransactionRow({
      payee,
      type: type === 'Income' ? 'Income' : 'Expense',
      sof,
      dateSerial,
      monthSerial,
      cleared,
      amount: parsedAmount,
      notes,
    });

    const sheets = getWriteSheetsClient();
    const spreadsheetId = process.env.SHEET_ID;

    // Issue #89: *saving* a transaction through ANY path here (full-sheet
    // edit, inline cell edit, keyboard row edit -- every one of them funnels
    // through this one endpoint) implicitly means the user has reviewed and
    // confirmed it, regardless of what Cleared ends up being saved as --
    // saving it back as Uncleared is still a deliberate save, not a no-op,
    // so Pending must never be left TRUE on a row that's just been saved.
    // (Originally this was scoped to "saved as Cleared" only; broadened per
    // the user's follow-up -- see claude/MNAB-live-status.md.) Mirrors the
    // `confirmPending` action's graceful-no-op handling above: Pending is a
    // self-provisioned column (see EmailImport.gs / issue #38) that may not
    // exist on this sheet yet, in which case there's nothing to clear.
    const headerMap = await getHeaderMap(sheets, spreadsheetId, 'transactions');
    const pendingCol = headerMap['Pending'] !== undefined ? columnLetter(headerMap['Pending']) : null;

    if (pendingCol) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `transactions!A${rowNumber}:K${rowNumber}`, values: [row] },
            { range: `transactions!${pendingCol}${rowNumber}`, values: [[false]] },
          ],
        },
      });
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `transactions!A${rowNumber}:K${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
    }

    // Payee registry upsert (see issue #52, and its edit-mode follow-up):
    // the transaction form now offers the same location-pin capture/toggle
    // on an edit as it does on a new transaction, so this endpoint needs
    // the same best-effort (non-fatal) coordinate write transactions-add.js
    // already does -- only overwrites the payee's stored Lat/Lon when the
    // form actually captured a position AND the toggle was left on for
    // this save; otherwise it's a no-op (existing-payee-row assumed, since
    // an edit's payee should already exist from whenever the row was
    // first added).
    try {
      const numLat = Number(lat);
      const numLon = Number(lon);
      const hasCoords = updatePayeeLocation === true && Number.isFinite(numLat) && Number.isFinite(numLon);
      await upsertPayee(sheets, {
        name: payee,
        lat: hasCoords ? numLat : undefined,
        lon: hasCoords ? numLon : undefined,
      });
    } catch (payeeErr) {
      console.error('Payee registry upsert failed (non-fatal):', payeeErr);
    }

    // WS1 Kind and C3 Category -- best-effort, same as the payee upsert
    // above; the two are independent, so they run side by side.
    let kindResult = null;
    let categoryResult = null;
    await Promise.all([
      rewriteKind(sheets, spreadsheetId, headerMap, rowNumber, row, req.body || {})
        .then((r) => { kindResult = r; })
        .catch((kindErr) => console.error('Kind write failed (non-fatal):', kindErr)),
      rewriteCategory(sheets, spreadsheetId, headerMap, rowNumber, row, req.body || {})
        .then((r) => { categoryResult = r; })
        .catch((catErr) => console.error('Category write failed (non-fatal):', catErr)),
    ]);

    res.status(200).json({
      ok: true,
      kind: kindResult && kindResult.kind,
      kindRule: kindResult && kindResult.rule,
      category: categoryResult && categoryResult.category,
      categoryRule: categoryResult && categoryResult.rule,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
