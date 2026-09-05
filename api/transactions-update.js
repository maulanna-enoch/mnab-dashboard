const { getWriteSheetsClient, buildTransactionRow, dateToSerial, getHeaderMap, columnLetter } = require('./_lib/sheets');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { rowNumber, payee, type, sof, date, month, cleared, amount, notes, action } = req.body || {};

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

    res.status(200).json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
