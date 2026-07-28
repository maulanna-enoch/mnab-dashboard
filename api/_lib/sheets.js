const { google } = require('googleapis');

// Bills use a far-future placeholder end date (e.g. Dec 2099) in the sheet to
// mean "recurring, doesn't really end" -- as opposed to Installments, which
// have a real payoff date. Anything ending in/after this year is a Bill.
const BILL_YEAR_THRESHOLD = 2099;

// Google Sheets serial-date epoch is Dec 30, 1899.
function serialToDate(serial) {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 24 * 60 * 60 * 1000);
}

async function fetchInstallmentRows() {
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
    // Without this, Sheets returns the *displayed* text (e.g. "Rp 5.000.000"),
    // which parseFloat can't read. This returns the underlying raw number/boolean.
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = response.data.values || [];

  return rows.map((row) => {
    const name = row[0] || '(unnamed)';
    const amount = parseFloat(row[2]) || 0;
    const isActiveRaw = row[3];
    const isActive = isActiveRaw === true || isActiveRaw === 'TRUE' || isActiveRaw === 'true';
    const endsSerial = row[4];
    const hasEndDate = typeof endsSerial === 'number';
    const endDate = hasEndDate ? serialToDate(endsSerial) : null;
    const isBill = hasEndDate && endDate.getUTCFullYear() >= BILL_YEAR_THRESHOLD;

    return { name, amount, isActive, hasEndDate, endDate, isBill };
  });
}

module.exports = { fetchInstallmentRows, serialToDate, BILL_YEAR_THRESHOLD };
