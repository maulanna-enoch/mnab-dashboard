// Web Push helpers for api/push.js.
//
// Storage: one row per subscribed device in a `PushSubscriptions` tab,
// created on first use. Columns:
//   A Endpoint | B P256dh | C Auth | D Device | E Created At
// The endpoint URL is the key (it's unique per browser install). An
// unsubscribed or expired device has its row CLEARED rather than deleted,
// so row numbers never shift under a concurrent request; blank rows are
// skipped on read and reused on the next subscribe.
//
// Sending: the `web-push` library does the VAPID signing and the payload
// encryption (aes128gcm). Both need ECDSA P-256, which is why sending
// lives here and not in Apps Script: EmailImport.gs just calls
// api/push.js with action=notify and this file does the rest.
//
// Env (Vercel):
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  from `npx web-push generate-vapid-keys`
//   VAPID_SUBJECT                         mailto: address push services can contact
//   PUSH_NOTIFY_SECRET                    shared with EmailImport.gs; guards action=notify
const webpush = require('web-push');

const PUSH_SHEET = 'PushSubscriptions';
const PUSH_HEADERS = ['Endpoint', 'P256dh', 'Auth', 'Device', 'Created At'];
const PUSH_RANGE = `${PUSH_SHEET}!A2:E`;

// The page a notification opens: the Transactions list, filtered to rows
// still waiting for review (?pending=1 is read by public/transactions).
const REVIEW_URL = '/transactions?pending=1';

// Lines listed in a multi-transaction notification before "+N more".
const MAX_LINES = 4;

function vapidConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let vapidApplied = false;
function applyVapid() {
  if (vapidApplied) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:mnab@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  vapidApplied = true;
}

// ── Sheet storage ─────────────────────────────────────────────────────

async function ensurePushSheet(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: process.env.SHEET_ID,
    fields: 'sheets.properties.title',
  });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === PUSH_SHEET);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: PUSH_SHEET } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${PUSH_SHEET}!A1:E1`,
    valueInputOption: 'RAW',
    requestBody: { values: [PUSH_HEADERS] },
  });
}

// Every stored row, blank (cleared) ones included, so callers can reuse a
// blank row. `rowNumber` is the 1-based sheet row.
async function readPushRows(sheets) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: PUSH_RANGE,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (response.data.values || []).map((row, i) => ({
    rowNumber: i + 2,
    endpoint: String(row[0] || '').trim(),
    p256dh: String(row[1] || ''),
    auth: String(row[2] || ''),
    device: String(row[3] || ''),
    createdAt: String(row[4] || ''),
  }));
}

async function fetchSubscriptions(sheets) {
  return (await readPushRows(sheets)).filter((r) => r.endpoint && r.p256dh && r.auth);
}

function toWebPushSubscription(row) {
  return { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
}

// Validates the shape PushSubscription.toJSON() produces. Only https
// endpoints are accepted: every real push service (Apple, Google, Mozilla)
// uses one, and it stops this endpoint being pointed at arbitrary URLs.
function parseSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = String(sub.endpoint || '').trim();
  const keys = sub.keys || {};
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000) return null;
  if (!keys.p256dh || !keys.auth) return null;
  return { endpoint, p256dh: String(keys.p256dh), auth: String(keys.auth) };
}

async function saveSubscription(sheets, sub, device) {
  await ensurePushSheet(sheets);
  const rows = await readPushRows(sheets);
  const existing = rows.find((r) => r.endpoint === sub.endpoint);
  const target = existing || rows.find((r) => !r.endpoint);
  const values = [[
    sub.endpoint,
    sub.p256dh,
    sub.auth,
    String(device || '').slice(0, 120),
    existing ? existing.createdAt : new Date().toISOString(),
  ]];

  if (target) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `${PUSH_SHEET}!A${target.rowNumber}:E${target.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
    return { updated: Boolean(existing) };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: `${PUSH_SHEET}!A:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  return { updated: false };
}

async function clearRow(sheets, rowNumber) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: process.env.SHEET_ID,
    range: `${PUSH_SHEET}!A${rowNumber}:E${rowNumber}`,
  });
}

async function removeSubscription(sheets, endpoint) {
  await ensurePushSheet(sheets);
  const rows = await readPushRows(sheets);
  const matches = rows.filter((r) => r.endpoint && r.endpoint === endpoint);
  for (const r of matches) await clearRow(sheets, r.rowNumber);
  return matches.length;
}

// ── Message composition ───────────────────────────────────────────────

function formatRupiah(amount) {
  return 'Rp' + Math.round(Math.abs(Number(amount) || 0)).toLocaleString('id-ID');
}

// One line per imported row. Mirrors how EmailImport.gs labels rows:
// "[NEEDS REVIEW] <subject>" when parsing failed, "[FAILED TRANSFER] <who>"
// when the bank reported a failure (amount 0, no money moved).
function describe(item) {
  const payee = String(item.payee || '').trim() || 'Unknown payee';
  const sof = String(item.sof || '').trim();

  if (/^\[NEEDS REVIEW\]/i.test(payee)) {
    return { kind: 'review', title: 'Email needs review', text: payee.replace(/^\[NEEDS REVIEW\]\s*/i, '') };
  }
  if (/^\[FAILED TRANSFER\]/i.test(payee)) {
    const who = payee.replace(/^\[FAILED TRANSFER\]\s*/i, '');
    return { kind: 'failed', title: 'Failed transfer · ' + who, text: ['Failed transfer', who, sof].filter(Boolean).join(' · ') };
  }

  const sign = item.type === 'Income' ? '+' : '−';
  const amount = sign + formatRupiah(item.amount);
  return {
    kind: 'txn',
    title: amount + ' · ' + payee,
    text: [amount, payee, sof].filter(Boolean).join(' · '),
    sof,
    transfer: Boolean(item.transfer),
  };
}

// items: [{ payee, type, sof, amount, transfer }] as EmailImport.gs sends
// them. Returns the JSON payload sw.js turns into a notification.
function composeNotification(items) {
  const list = (items || []).map(describe);
  if (list.length === 0) return null;

  if (list.length === 1) {
    const d = list[0];
    let body;
    if (d.kind === 'review') body = d.text;
    else if (d.kind === 'failed') body = 'No money moved. Tap to review.';
    else body = [d.sof, d.transfer ? 'Transfer' : null, 'Pending review'].filter(Boolean).join(' · ');
    return { title: d.title, body, url: REVIEW_URL };
  }

  const lines = list.slice(0, MAX_LINES).map((d) => (d.kind === 'review' ? 'Needs review: ' + d.text : d.text));
  if (list.length > MAX_LINES) lines.push('+' + (list.length - MAX_LINES) + ' more');
  return { title: list.length + ' new transactions', body: lines.join('\n'), url: REVIEW_URL };
}

// ── Sending ───────────────────────────────────────────────────────────

// Sends `payload` to every row given. Push services answer 404/410 for a
// subscription that no longer exists (app removed from the Home Screen,
// permission revoked); those rows are cleared so they aren't retried.
async function sendToAll(sheets, rows, payload) {
  applyVapid();
  const body = JSON.stringify(payload);
  const results = await Promise.all(rows.map(async (row) => {
    try {
      await webpush.sendNotification(toWebPushSubscription(row), body, { TTL: 24 * 60 * 60, urgency: 'normal' });
      return { ok: true };
    } catch (err) {
      const gone = err && (err.statusCode === 404 || err.statusCode === 410);
      if (gone) await clearRow(sheets, row.rowNumber);
      return { ok: false, gone, status: err && err.statusCode, error: err && err.message };
    }
  }));
  return {
    sent: results.filter((r) => r.ok).length,
    removed: results.filter((r) => r.gone).length,
    failed: results.filter((r) => !r.ok && !r.gone).map((r) => ({ status: r.status, error: r.error })),
  };
}

module.exports = {
  PUSH_SHEET,
  REVIEW_URL,
  vapidConfigured,
  ensurePushSheet,
  readPushRows,
  fetchSubscriptions,
  parseSubscription,
  saveSubscription,
  removeSubscription,
  composeNotification,
  formatRupiah,
  sendToAll,
};
