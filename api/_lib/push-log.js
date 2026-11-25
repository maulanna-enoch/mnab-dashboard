// Push log: remembers which one-off notifications have already gone out, so
// a reminder that can be triggered many times (the weekly budget warning
// runs after every save and every email import) is only sent once.
//
// Storage: a `PushLog` tab, created on first use. Columns:
//   A Key | B Sent At | C Title
// Append-only. Keys are made by the caller and include the period they
// cover, e.g. "budget-warn:2026-11-25" (the week's start day) -- so a new
// week gets a new key and nothing ever needs clearing. Old rows can be
// deleted by hand at any time; the worst case is one repeated reminder.
//
// Rupiah amounts stay out of this tab: the Title column holds the
// notification's title only for a human scanning the log.

const PUSH_LOG_SHEET = 'PushLog';
const PUSH_LOG_HEADERS = ['Key', 'Sent At', 'Title'];

async function ensurePushLogSheet(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: process.env.SHEET_ID,
    fields: 'sheets.properties.title',
  });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === PUSH_LOG_SHEET);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: PUSH_LOG_SHEET } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${PUSH_LOG_SHEET}!A1:C1`,
    valueInputOption: 'RAW',
    requestBody: { values: [PUSH_LOG_HEADERS] },
  });
}

// Set of every key already logged.
async function fetchSentKeys(sheets) {
  await ensurePushLogSheet(sheets);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${PUSH_LOG_SHEET}!A2:A`,
  });
  return new Set((response.data.values || []).map((r) => String(r[0] || '').trim()).filter(Boolean));
}

// entries: [{ key, title }]
async function markSent(sheets, entries, now = new Date()) {
  if (!entries || entries.length === 0) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: `${PUSH_LOG_SHEET}!A:C`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: entries.map((e) => [e.key, now.toISOString(), String(e.title || '').slice(0, 200)]) },
  });
}

module.exports = {
  PUSH_LOG_SHEET,
  ensurePushLogSheet,
  fetchSentKeys,
  markSent,
};
