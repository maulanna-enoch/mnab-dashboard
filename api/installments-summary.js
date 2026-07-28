const { google } = require('googleapis');

module.exports = async (req, res) => {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Columns in "installmentsbills": Name, SOF, Amount, is_active, Ends, Starts, Months, Remarks, day of month
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'installmentsbills!A2:I',
      // Without this, Sheets returns the *displayed* text (e.g. "Rp 5.000.000"),
      // which parseFloat can't read. This returns the underlying raw number/boolean.
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = response.data.values || [];

    let total = 0;
    let activeCount = 0;

    for (const row of rows) {
      const amount = parseFloat(row[2]) || 0;
      const isActiveRaw = row[3];
      const isActive = isActiveRaw === true || isActiveRaw === 'TRUE' || isActiveRaw === 'true';
      if (isActive) {
        total += amount;
        activeCount += 1;
      }
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      total,
      activeCount,
      rowsRead: rows.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
