const { getWriteSheetsClient, buildTransactionRow, dateToSerial, getHeaderMap, columnLetter, upsertPayee, getSheetGridId } = require('./_lib/sheets');

// Issue #51: finds every row on `transactions` currently stamped with
// `matchId` (self-provisioned "Match ID"/"Match Status" columns -- see
// EmailImport.gs). Returns null if the sheet has no Match ID column at all
// (nothing to resolve). Used by both confirmMatch and unmatchMatch below.
async function findMatchRows(sheets, spreadsheetId, headerMap, matchId) {
  if (headerMap['Match ID'] === undefined) return null;
  const matchIdCol = headerMap['Match ID'];
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'transactions!A2:Z',
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { rowNumber, payee, type, sof, date, month, cleared, amount, notes, action, lat, lon, updatePayeeLocation, matchId } = req.body || {};

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

    res.status(200).json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
