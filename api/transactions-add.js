const {
  getWriteSheetsClient,
  buildTransactionRow,
  dateToSerial,
  upsertPayee,
  fetchPayeeRows,
  getHeaderMap,
  writeTransactionKind,
} = require('./_lib/sheets');
const { kindForSave, payeeKindMap, normalizeBillId } = require('./_lib/kinds');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { payee, type, sof, date, month, cleared, amount, notes, lat, lon, updatePayeeLocation, kind, kindManual, billId } = req.body || {};

    if (!payee || !type || !sof || !date || !month || !cleared || amount === undefined || amount === null) {
      res.status(400).json({ error: 'Missing required field: payee, type, sof, date, month, cleared, amount are all required' });
      return;
    }

    const parsedAmount = parseFloat(amount);
    if (Number.isNaN(parsedAmount)) {
      res.status(400).json({ error: 'amount must be a number' });
      return;
    }

    // date and month arrive as "YYYY-MM-DD" / "YYYY-MM" from the form.
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
    const appended = await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: 'transactions!A:K',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    // WS1: Kind / Kind Rule and the Bill ID (Source ID) -- see
    // api/_lib/kinds.js. Best-effort like the payee upsert below: readers
    // recompute Kind anyway, so a failure here can only lose a hand-set
    // Kind or bill link, never the transaction itself.
    let kindResult = null;
    try {
      const updatedRange = (appended.data && appended.data.updates && appended.data.updates.updatedRange) || '';
      const m = updatedRange.match(/![A-Z]+(\d+)/);
      if (!m) throw new Error(`Couldn't read the new row number from "${updatedRange}"`);
      const rowNumber = Number(m[1]);
      const link = normalizeBillId(billId);
      const payeeKinds = payeeKindMap(await fetchPayeeRows(sheets));
      kindResult = kindForSave(
        { type: row[1], isTransfer: false, billId: link, notes: row[10], payee },
        { kind, kindManual },
        null,
        payeeKinds,
      );
      const headerMap = await getHeaderMap(sheets, process.env.SHEET_ID, 'transactions');
      await writeTransactionKind(sheets, headerMap, rowNumber, { ...kindResult, billId: link ? link : undefined });
    } catch (kindErr) {
      console.error('Kind write failed (non-fatal):', kindErr);
    }

    // Payee registry upsert (see issue #52). Always ensures a `Payees` row
    // exists for this payee; also (over)writes its coordinates, but ONLY
    // when the form actually captured a position AND the user left the
    // location-pin toggle on for this save -- `updatePayeeLocation` is that
    // toggle's state, sent explicitly by transaction-form.js rather than
    // inferred here. Best-effort: a failure here must never fail a
    // transaction save that already succeeded above.
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

    res.status(200).json({ ok: true, kind: kindResult && kindResult.kind, kindRule: kindResult && kindResult.rule, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
