const { getWriteSheetsClient, buildTransactionRow, dateToSerial } = require('./_lib/sheets');

// Shared-secret guard (see issue #30): this endpoint is the write path a
// Siri Shortcut (or any other out-of-app client) can hit directly, so it
// needs *something* between it and the open internet -- not just its URL
// being hard to guess. This is NOT strong auth: the same token also lives
// in public/shared/transaction-form.js so the dashboard's own Add button
// keeps working, and that file ships to every browser as plain JS. It only
// raises the bar against blind/opportunistic traffic (scanners, stray bots
// hitting the URL by chance) -- not against someone who actually inspects
// this app's own client code. Set MNAB_WRITE_TOKEN in Vercel's project env
// vars to the same value hardcoded in transaction-form.js's WRITE_TOKEN.
function isAuthorized(req) {
  const expected = process.env.MNAB_WRITE_TOKEN;
  return !!expected && req.headers['x-mnab-token'] === expected;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const { payee, type, sof, date, month, cleared, amount, notes } = req.body || {};

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

    res.status(200).json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
