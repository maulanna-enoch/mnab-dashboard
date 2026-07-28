const { google } = require('googleapis');

// Google Sheets serial-date epoch is Dec 30, 1899.
function serialToDate(serial) {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 24 * 60 * 60 * 1000);
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

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

    // Columns: Name, SOF, Amount, is_active, Ends, Starts, Months, Remarks, day of month
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'installmentsbills!A2:I',
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = response.data.values || [];

    const groups = {}; // monthKey -> { amountEnding, items: [{name, amount}] }
    const noEndDateItems = [];
    let totalActive = 0;

    for (const row of rows) {
      const name = row[0] || '(unnamed)';
      const amount = parseFloat(row[2]) || 0;
      const isActiveRaw = row[3];
      const isActive = isActiveRaw === true || isActiveRaw === 'TRUE' || isActiveRaw === 'true';
      const endsSerial = row[4];

      if (!isActive) continue;
      totalActive += amount;

      if (typeof endsSerial !== 'number') {
        noEndDateItems.push({ name, amount });
        continue;
      }

      const key = monthKey(serialToDate(endsSerial));
      if (!groups[key]) groups[key] = { amountEnding: 0, items: [] };
      groups[key].amountEnding += amount;
      groups[key].items.push({ name, amount });
    }

    const sortedKeys = Object.keys(groups).sort();
    let cumulativeEnded = 0;
    const months = sortedKeys.map((key) => {
      cumulativeEnded += groups[key].amountEnding;
      return {
        month: key,
        label: monthLabel(key),
        amountEnding: groups[key].amountEnding,
        count: groups[key].items.length,
        items: groups[key].items,
        remainingAfter: totalActive - cumulativeEnded,
      };
    });

    const noEndDateTotal = noEndDateItems.reduce((sum, i) => sum + i.amount, 0);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      totalActive,
      months,
      noEndDate: {
        amount: noEndDateTotal,
        count: noEndDateItems.length,
        items: noEndDateItems,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
