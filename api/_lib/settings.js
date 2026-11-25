// Settings tab: one place for the numbers the weekly-budget work depends on
// (Debt Exit plan, WS0).
//
// The sheet tab is a plain key/value list -- columns A: Key, B: Value,
// C: Notes -- read by KEY, never by row position, so rows can be reordered
// or annotated freely. Unknown keys are ignored; a bad value falls back to
// its default and adds a warning rather than throwing.
//
// This file is pure parsing (no Sheets API) so it can be tested in Node
// without credentials. The fetch lives in sheets.js as fetchSettings().
//
// Rupiah values here are the user's own figures and stay inside MNAB. Never
// copy them into the Claude Sheet (that side only ever gets percentages).

const SETTINGS_TAB = 'Settings';
const SETTINGS_RANGE = `${SETTINGS_TAB}!A2:C`;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Every setting the app knows about. `default: null` means "no sensible
// default -- the page should ask the user to fill it in".
const SETTINGS_SCHEMA = {
  weekly_allowance_rp: { type: 'rupiah', default: null, description: 'Weekly variable-spending allowance, in Rp' },
  week_start_day: { type: 'weekday', default: 'Wednesday', description: 'First day of the budget week' },
  rollover_enabled: { type: 'boolean', default: true, description: 'Carry unspent allowance into the next week' },
  rollover_cap_rp: { type: 'rupiah', default: null, description: 'Max carried over, in Rp (blank = no cap)' },
  monthly_salary_rp: { type: 'rupiah', default: null, description: 'Monthly salary, in Rp' },
  hole_start_date: { type: 'date', default: null, description: 'Date the Steals hole is counted from' },
  budget_start_date: { type: 'date', default: null, optional: true, description: 'First day the weekly budget counts from; rollover starts that week (blank = oldest week shown)' },
  // Debt projection (WS6). Mirror the Claude Sheet's Assumptions tab.
  hole_fee_pct: { type: 'percent', default: 0.01, max: 0.1, optional: true, description: 'Lender fee on the hole per 30 days, e.g. 1%' },
  job_start_date: { type: 'date', default: null, optional: true, description: 'Start date at the current job (for the prorated THR)' },
  thr_date: { type: 'date', default: null, optional: true, description: 'Date the THR is paid (blank = no THR in the projection)' },
  thr_rp: { type: 'rupiah', default: null, optional: true, description: 'THR amount in Rp (blank = worked out from job_start_date and salary)' },
  thr_share_pct: { type: 'percent', default: 1, max: 1, optional: true, description: 'Share of the THR put toward the hole, e.g. 100%' },
  raise_pct: { type: 'percent', default: 0.02, max: 0.5, optional: true, description: 'Yearly raise, e.g. 2%' },
  first_raise_date: { type: 'date', default: null, optional: true, description: 'When the first raise takes effect (blank = no raises in the projection)' },
};

const pad2 = (n) => String(n).padStart(2, '0');

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

// Integer rupiah, >= 0. Accepts a number, or text like "5000000",
// "5.000.000", "Rp 5.000.000" or "5,000,000" (consistent thousand
// separators only -- "5,5" or "5.000,50" are rejected rather than guessed).
function parseRupiah(v) {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  }
  const s = String(v).replace(/^\s*rp\.?\s*/i, '').replace(/\s+/g, '');
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g, ''));
  return undefined;
}

// Full name, 3-letter prefix, or 0-6 (0 = Sunday). Case-insensitive.
function parseWeekday(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6) return WEEKDAYS[v];
  const s = String(v).trim().toLowerCase();
  if (s.length < 3) return undefined;
  return WEEKDAYS.find((d) => d.toLowerCase().startsWith(s) && (s.length === 3 || d.toLowerCase() === s));
}

function parseBoolean(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'y', 'on', '1'].includes(s)) return true;
  if (['false', 'no', 'n', 'off', '0'].includes(s)) return false;
  return undefined;
}

// Returns 'YYYY-MM-DD'. Accepts a Sheets date serial (UNFORMATTED_VALUE),
// dd/mm/yyyy (the sheet's en_GB locale) or yyyy-mm-dd. Built from date
// parts only -- never via toISOString(), which shifts WIB dates back a day.
function parseDate(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    // A serial is a calendar date with no time zone; reading it in UTC is exact.
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let y, m, d;
  let match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) [, d, m, y] = match.map(Number);
  else if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = match.map(Number);
  else return undefined;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return undefined;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// A fraction (0.01 = 1%). Accepts a cell formatted as a percentage (Sheets
// returns 0.01 for "1%"), text with a % sign ("1%", "1,5%", "2.5 %"), or a
// bare number: up to 1 is read as a fraction, above 1 as percentage points
// (so 2 = 2%, but 1 = 100% -- type "1%" for one percent). Negative -> invalid.
function parsePercent(v) {
  let n;
  let isPoints = false;
  if (typeof v === 'number') {
    n = v;
  } else {
    let s = String(v).trim().replace(/\s+/g, '');
    if (s.endsWith('%')) { isPoints = true; s = s.slice(0, -1); }
    s = s.replace(',', '.');
    if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return undefined;
    n = Number(s);
  }
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (isPoints || n > 1) n /= 100;
  return n;
}

const PARSERS = { rupiah: parseRupiah, weekday: parseWeekday, boolean: parseBoolean, date: parseDate, percent: parsePercent };

function normalizeKey(k) {
  return String(k || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// rows: the raw values from SETTINGS_RANGE (array of [key, value, notes]),
// or null when the tab doesn't exist yet.
// Returns { values, warnings, tabFound }.
function parseSettings(rows) {
  const values = {};
  const warnings = [];
  const seen = {};
  Object.keys(SETTINGS_SCHEMA).forEach((k) => { values[k] = SETTINGS_SCHEMA[k].default; });

  if (!rows) {
    warnings.push(`No "${SETTINGS_TAB}" tab found -- using defaults.`);
  } else {
    rows.forEach((row, i) => {
      const rowNumber = i + 2;
      const key = normalizeKey(row && row[0]);
      if (!key) return;
      const spec = SETTINGS_SCHEMA[key];
      if (!spec) return; // unknown keys are allowed (notes, future settings)
      if (seen[key]) {
        warnings.push(`${key} appears twice (rows ${seen[key]} and ${rowNumber}) -- using row ${seen[key]}.`);
        return;
      }
      seen[key] = rowNumber;
      const raw = row[1];
      if (isBlank(raw)) return; // blank = default
      const parsed = PARSERS[spec.type](raw);
      if (parsed === undefined) {
        warnings.push(`${key} (row ${rowNumber}): couldn't read "${raw}" as ${spec.type} -- using the default.`);
        return;
      }
      if (typeof spec.max === 'number' && parsed > spec.max) {
        warnings.push(`${key} (row ${rowNumber}): "${raw}" is more than ${spec.max * 100}% -- using the default.`);
        return;
      }
      values[key] = parsed;
    });
  }

  Object.keys(SETTINGS_SCHEMA).forEach((k) => {
    if (values[k] === null && k !== 'rollover_cap_rp' && !SETTINGS_SCHEMA[k].optional) warnings.push(`${k} is not set.`);
  });

  values.week_start_index = WEEKDAYS.indexOf(values.week_start_day);
  return { values, warnings, tabFound: !!rows };
}

module.exports = {
  SETTINGS_TAB,
  SETTINGS_RANGE,
  SETTINGS_SCHEMA,
  WEEKDAYS,
  parseSettings,
  parseRupiah,
  parseWeekday,
  parseBoolean,
  parseDate,
  parsePercent,
};
