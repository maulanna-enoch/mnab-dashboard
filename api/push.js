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
// GET  ?action=morning                                -> the morning money push
// POST action=morning        { dryRun }               (bills due today + daily
//      budget left) to every device. GET is what the Vercel cron in
//      vercel.json calls, with "Authorization: Bearer <CRON_SECRET>"; POST
//      is for a manual run with PUSH_NOTIFY_SECRET. dryRun: true returns the
//      message without sending it. See api/_lib/morning.js.
// GET  ?action=evening                                -> bills and Steals due
// POST action=evening        { dryRun }               TOMORROW, to every
//      device; nothing is sent when nothing is due. Same auth as morning
//      (its own Vercel cron). See api/_lib/alerts.js.
// POST action=budget-check   { dryRun }               -> the weekly budget
//      warning (push_budget_warn_pct, 70% by default) or the over-budget
//      push, at most once per week each (PushLog tab). Called by
//      shared/transaction-form.js after every save; action=notify runs the
//      same check after an email import. Not authenticated, like the other
//      dashboard writes: it can only ever send these two deduped messages.
//
// Debt Exit WS8 added evening, budget-check, the week-start "Allowance
// ready" morning variant and Steals due dates (the Steals tab's optional
// Due Date column).
//
// Note: like every other /api endpoint, subscribe/unsubscribe/test are not
// authenticated. Only notify, the one that broadcasts, needs the secret.
const crypto = require('crypto');
const { getWriteSheetsClient, fetchInstallmentRows, fetchSettings, fetchClassifiedTransactionRows, fetchStealsRows } = require('./_lib/sheets');
const { computeWeek } = require('./_lib/week');
const push = require('./_lib/push');
const morning = require('./_lib/morning');
const alerts = require('./_lib/alerts');
const pushLog = require('./_lib/push-log');

function secretMatches(header, secret = process.env.PUSH_NOTIFY_SECRET || '') {
  const given = String(header || '').replace(/^Bearer\s+/i, '');
  if (!secret || !given) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Vercel's cron sends CRON_SECRET; a manual call can use PUSH_NOTIFY_SECRET.
function morningAuthorized(req) {
  const header = req.headers && req.headers.authorization;
  return secretMatches(header, process.env.CRON_SECRET || '') || secretMatches(header);
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

  // New card swipes are the usual way the week's budget gets used up, so
  // check it now. Best effort: the import push above already went out.
  let budget = null;
  try {
    budget = await runBudgetCheck(sheets, rows, false);
  } catch (err) {
    console.error('Budget check after notify failed (non-fatal):', err);
    budget = { error: err.message };
  }
  res.status(200).json({ ok: true, devices: rows.length, ...result, budget });
}

// This week's budget (WS4), the same call and default history as
// ?action=week so the rollover matches what Home shows.
function currentWeek(txns, settings) {
  return computeWeek(txns, settings, { includeTransactions: false }).week;
}

// Sends the budget warning / over-budget push if it's due and hasn't gone
// out this week. `rows`: subscriptions, or null to read them here.
// Returns what happened, without amounts unless dryRun.
async function runBudgetCheck(sheets, rows, dryRun) {
  const [{ values: settings }, txns] = await Promise.all([fetchSettings(), fetchClassifiedTransactionRows()]);
  const week = currentWeek(txns, settings);
  const level = alerts.budgetLevel(week, alerts.warnPctFrom(settings));
  const sentKeys = await pushLog.fetchSentKeys(sheets);
  const note = alerts.budgetNotification(week, settings, sentKeys);
  const status = { level: level ? level.level : 'no-allowance', weekStart: week.start };
  if (!note) return { ...status, sent: false };
  if (dryRun) return { ...status, sent: false, dryRun: true, payload: note.payload, markKeys: note.markKeys.map((k) => k.key) };
  if (!push.vapidConfigured()) return { ...status, sent: false, reason: 'vapid-not-configured' };

  const subs = rows || (await push.fetchSubscriptions(sheets));
  if (subs.length === 0) return { ...status, sent: false, reason: 'no-devices' };
  const result = await push.sendToAll(sheets, subs, note.payload);
  // Log only once something was delivered, so a failed send is retried on
  // the next check instead of being lost.
  if (result.sent > 0) await pushLog.markSent(sheets, note.markKeys);
  return { ...status, sent: result.sent > 0, devices: subs.length, delivered: result.sent };
}

async function actionBudgetCheck(body, res) {
  const sheets = getWriteSheetsClient();
  const outcome = await runBudgetCheck(sheets, null, body.dryRun === true);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, ...outcome });
}

async function actionEvening(req, res, dryRun) {
  if (!process.env.CRON_SECRET && !process.env.PUSH_NOTIFY_SECRET) {
    res.status(503).json({ error: 'Set CRON_SECRET (or PUSH_NOTIFY_SECRET) in Vercel.' });
    return;
  }
  if (!morningAuthorized(req)) {
    res.status(401).json({ error: 'Bad or missing bearer token' });
    return;
  }

  const tomorrow = alerts.addDays(morning.jakartaToday(), 1);
  const [installments, stealsRows] = await Promise.all([
    fetchInstallmentRows(),
    fetchStealsRows().catch((err) => {
      console.error('Steals read for the evening push failed (non-fatal):', err);
      return null;
    }),
  ]);
  const message = alerts.composeEvening({
    bills: morning.billsDueOn(installments, tomorrow),
    steals: alerts.stealsDueOn(stealsRows, alerts.isoOf(tomorrow)),
    tomorrow,
  });

  res.setHeader('Cache-Control', 'no-store');
  if (!message) {
    res.status(200).json({ ok: true, dryRun, sent: 0, reason: 'nothing due tomorrow' });
    return;
  }
  const { summary, ...payload } = message;
  if (dryRun) {
    res.status(200).json({ ok: true, dryRun: true, payload, summary });
    return;
  }
  if (!requireVapid(res)) return;

  const sheets = getWriteSheetsClient();
  await push.ensurePushSheet(sheets);
  const rows = await push.fetchSubscriptions(sheets);
  const result = await push.sendToAll(sheets, rows, payload);
  res.status(200).json({ ok: true, devices: rows.length, ...result });
}

async function actionMorning(req, res, dryRun) {
  if (!process.env.CRON_SECRET && !process.env.PUSH_NOTIFY_SECRET) {
    res.status(503).json({ error: 'Set CRON_SECRET (or PUSH_NOTIFY_SECRET) in Vercel.' });
    return;
  }
  if (!morningAuthorized(req)) {
    res.status(401).json({ error: 'Bad or missing bearer token' });
    return;
  }

  const today = morning.jakartaToday();
  const [installments, { values: settings }, txns, stealsRows] = await Promise.all([
    fetchInstallmentRows(),
    fetchSettings(),
    fetchClassifiedTransactionRows(),
    fetchStealsRows().catch((err) => {
      console.error('Steals read for the morning push failed (non-fatal):', err);
      return null;
    }),
  ]);
  // Best-effort: a settings problem mustn't stop the bills part of the push.
  let week = null;
  try {
    week = currentWeek(txns, settings);
  } catch (err) {
    console.error('Weekly budget for the morning push failed (non-fatal):', err);
  }
  const message = morning.composeMorning({
    bills: morning.billsDueOn(installments, today),
    week,
    steals: alerts.stealsDueOn(stealsRows, alerts.isoOf(today)),
    warnPct: alerts.warnPctFrom(settings),
  });
  const { summary, ...payload } = message;

  res.setHeader('Cache-Control', 'no-store');
  if (dryRun) {
    res.status(200).json({ ok: true, dryRun: true, payload, summary });
    return;
  }
  if (!requireVapid(res)) return;

  const sheets = getWriteSheetsClient();
  await push.ensurePushSheet(sheets);
  const rows = await push.fetchSubscriptions(sheets);
  const result = await push.sendToAll(sheets, rows, payload);
  // The response carries counts only, not the amounts.
  res.status(200).json({ ok: true, devices: rows.length, ...result });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const action = (req.query && req.query.action) || 'config';
      if (action === 'config') return await actionConfig(res);
      if (action === 'morning') return await actionMorning(req, res, false);
      if (action === 'evening') return await actionEvening(req, res, false);
      res.status(400).json({ error: 'Unknown GET action. Use ?action=config, ?action=morning or ?action=evening.' });
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
      case 'morning': return await actionMorning(req, res, body.dryRun === true);
      case 'evening': return await actionEvening(req, res, body.dryRun === true);
      case 'budget-check': return await actionBudgetCheck(body, res);
      default:
        res.status(400).json({ error: 'Unknown or missing action. Use one of: subscribe, unsubscribe, test, notify, morning, evening, budget-check.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
