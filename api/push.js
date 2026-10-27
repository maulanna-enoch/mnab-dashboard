// Web Push endpoint, same action-dispatcher pattern as api/reconcile.js and
// api/payees-list.js. It got its own file because api/cashflow-months.js
// was folded into api/cashflow-summary.js to free a slot under Vercel
// Hobby's 12-function cap.
//
// GET  ?action=config        -> { enabled, publicKey } for shared/push.js.
// POST action=subscribe      { subscription, device } -> store this device.
// POST action=unsubscribe    { endpoint }             -> forget this device.
// POST action=test           { endpoint }             -> one test push to that
//                                                         device only.
// POST action=notify         { items: [...] }         -> push to every device.
//      Requires "Authorization: Bearer <PUSH_NOTIFY_SECRET>". Called by
//      apps-script/EmailImport.gs after an import run writes new rows.
//
// Note: like every other /api endpoint, subscribe/unsubscribe/test are not
// authenticated. Only notify, the one that broadcasts, needs the secret.
const crypto = require('crypto');
const { getWriteSheetsClient } = require('./_lib/sheets');
const push = require('./_lib/push');

function secretMatches(header) {
  const secret = process.env.PUSH_NOTIFY_SECRET || '';
  const given = String(header || '').replace(/^Bearer\s+/i, '');
  if (!secret || !given) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireVapid(res) {
  if (push.vapidConfigured()) return true;
  res.status(503).json({ error: 'Push is not configured: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Vercel.' });
  return false;
}

async function actionConfig(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    enabled: push.vapidConfigured(),
    publicKey: process.env.VAPID_PUBLIC_KEY || null,
  });
}

async function actionSubscribe(body, res) {
  if (!requireVapid(res)) return;
  const sub = push.parseSubscription(body.subscription);
  if (!sub) {
    res.status(400).json({ error: 'subscription must be a PushSubscription JSON with an https endpoint and keys.p256dh/keys.auth' });
    return;
  }
  const sheets = getWriteSheetsClient();
  const { updated } = await push.saveSubscription(sheets, sub, body.device);
  res.status(200).json({ ok: true, updated });
}

async function actionUnsubscribe(body, res) {
  const endpoint = String(body.endpoint || '').trim();
  if (!endpoint) {
    res.status(400).json({ error: 'endpoint is required' });
    return;
  }
  const removed = await push.removeSubscription(getWriteSheetsClient(), endpoint);
  res.status(200).json({ ok: true, removed });
}

async function actionTest(body, res) {
  if (!requireVapid(res)) return;
  const endpoint = String(body.endpoint || '').trim();
  const sheets = getWriteSheetsClient();
  const rows = (await push.fetchSubscriptions(sheets)).filter((r) => r.endpoint === endpoint);
  if (!endpoint || rows.length === 0) {
    res.status(404).json({ error: 'This device is not subscribed. Turn notifications on first.' });
    return;
  }
  const result = await push.sendToAll(sheets, rows, {
    title: 'MNAB notifications are on',
    body: 'New bank transactions will show up here.',
    url: push.REVIEW_URL,
  });
  res.status(200).json({ ok: result.sent > 0, ...result });
}

async function actionNotify(req, res) {
  if (!process.env.PUSH_NOTIFY_SECRET) {
    res.status(503).json({ error: 'PUSH_NOTIFY_SECRET is not set in Vercel.' });
    return;
  }
  if (!secretMatches(req.headers && req.headers.authorization)) {
    res.status(401).json({ error: 'Bad or missing bearer token' });
    return;
  }
  if (!requireVapid(res)) return;

  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 200) : [];
  const payload = push.composeNotification(items);
  if (!payload) {
    res.status(200).json({ ok: true, sent: 0, reason: 'no items' });
    return;
  }

  const sheets = getWriteSheetsClient();
  await push.ensurePushSheet(sheets);
  const rows = await push.fetchSubscriptions(sheets);
  const result = await push.sendToAll(sheets, rows, payload);
  res.status(200).json({ ok: true, devices: rows.length, ...result });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const action = (req.query && req.query.action) || 'config';
      if (action === 'config') return await actionConfig(res);
      res.status(400).json({ error: 'Unknown GET action. Use ?action=config.' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Use GET or POST' });
      return;
    }

    const body = req.body || {};
    switch (body.action) {
      case 'subscribe': return await actionSubscribe(body, res);
      case 'unsubscribe': return await actionUnsubscribe(body, res);
      case 'test': return await actionTest(body, res);
      case 'notify': return await actionNotify(req, res);
      default:
        res.status(400).json({ error: 'Unknown or missing action. Use one of: subscribe, unsubscribe, test, notify.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
