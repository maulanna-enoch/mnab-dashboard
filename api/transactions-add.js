const { getWriteSheetsClient, buildTransactionRow, dateToSerial, upsertPayee } = require('./_lib/sheets');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { payee, type, sof, date, month, cleared, amount, notes, lat, lon, updatePayeeLocation } = req.body || {};

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
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: 'transactions!A:K',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

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

    res.status(200).json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
