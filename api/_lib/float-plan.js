// Reads the `Float Plan` tab built by apps-script/FloatPlan.gs. That tab is
// the source of truth: every number is a live Sheets formula, and this module
// only picks the cells out by their fixed positions (documented at the top
// of FloatPlan.gs -- move them only together).
//
// Served by /api/cashflow-summary?action=float rather than its own file,
// because Vercel Hobby's 12-function cap is already used up.
const { getSheetsClient, serialToDate, monthKey } = require('./sheets');

const SHEET = 'Float Plan';
const FIRST_DATA_ROW = 16;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function month(v) {
  return typeof v === 'number' ? monthKey(serialToDate(v)) : null;
}

function text(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

// `values` is the UNFORMATTED A1:H(FIRST_DATA_ROW+59) grid; rows are 0-based.
// Pure, so it can be tested without the Sheets API.
function parseFloatPlan(values) {
  const cell = (row1, colLetter) => {
    const r = values[row1 - 1] || [];
    return r[colLetter.charCodeAt(0) - 65];
  };

  const months = [];
  for (let r = FIRST_DATA_ROW; r <= values.length; r++) {
    const m = month(cell(r, 'A'));
    if (!m) continue;
    months.push({
      month: m,
      cap: num(cell(r, 'B')),
      spend: num(cell(r, 'C')),
      delta: num(cell(r, 'D')),
      status: text(cell(r, 'E')),
      fromBank: num(cell(r, 'F')),
    });
  }

  const cards = [];
  for (let r = 6; r <= Math.min(values.length, 40); r++) {
    const c = text(cell(r, 'H'));
    if (c && c !== 'No credit card accounts found') cards.push(c);
  }

  return {
    exists: true,
    now: {
      cap: num(cell(3, 'A')),
      spend: num(cell(3, 'B')),
      left: num(cell(3, 'C')),
      freeBy: month(cell(3, 'D')),
      monthsLeft: num(cell(3, 'E')),
      status: text(cell(3, 'F')),
    },
    settings: {
      start: month(cell(6, 'B')),
      baseline: num(cell(7, 'B')),
      suggestedCut: num(cell(8, 'B')),
      customCut: num(cell(9, 'B')),
      cut: num(cell(10, 'B')),
      planMonths: num(cell(11, 'B')),
      freeBy: month(cell(12, 'B')),
    },
    cards,
    months,
  };
}

async function fetchFloatPlan() {
  const sheets = getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: `'${SHEET}'!A1:H${FIRST_DATA_ROW + 59}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return parseFloatPlan(res.data.values || []);
  } catch (err) {
    // The tab doesn't exist until Finances > Set Up Float Plan… has been run.
    if (/Unable to parse range/i.test(err.message || '')) return { exists: false };
    throw err;
  }
}

module.exports = { parseFloatPlan, fetchFloatPlan, FIRST_DATA_ROW };
