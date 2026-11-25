# Push notifications setup

When `EmailImport.gs` imports new bank transactions, every device that turned
notifications on gets one push, for example:

- one row: **−Rp150.000 · GoFood**, with *mandiri · Pending review* underneath
- several rows: **3 new transactions**, one line each (up to four, then "+N more")

Tapping it opens Transactions filtered to rows pending review
(`/transactions?pending=1`).

## The other pushes (Debt Exit WS8)

| Push | When | What it says |
|---|---|---|
| Morning | Daily ~06:00 WIB (Vercel cron, `?action=morning`) | Bills due today, Steals due today, this week's budget per day. Once past the warning threshold, a "% used" line. |
| Allowance ready | The morning push on the first day of the budget week (`week_start_day`, Wednesday by default) | This week's allowance, with last week's carry-over or overspend spelled out. |
| Evening | Daily ~19:00 WIB (Vercel cron, `?action=evening`) | Bills and installments due **tomorrow**, and Steals rows whose **Due Date** is tomorrow. Nothing is sent on a day with nothing due. |
| Budget warning | As soon as this week's Variable spending passes `push_budget_warn_pct` of what's available (70% by default) | % used, what's left, per day from here. Once per week. |
| Over budget | As soon as Variable spending goes past what's available | How much over. Once per week. If spending jumps straight past 100%, only this one is sent. |

Vercel Hobby crons fire somewhere inside the scheduled hour, so "06:00" can
be 06:00–06:59 and "19:00" 19:00–19:59.

**When the budget is checked.** After every save in the Add/Edit form
(`shared/transaction-form.js` calls `action=budget-check`), and after every
email import (`action=notify` runs the same check). Swipe/bulk edits and the
Import Inbox don't trigger a check; the next save, import or morning push
catches up. What's already been sent is logged in a `PushLog` tab (created on
first use: Key, Sent At, Title; no amounts). Deleting rows from it is safe;
at worst a reminder repeats.

**Settings tab (optional).** `push_budget_warn_pct`: the warning threshold,
e.g. `70%` or `80%`. Blank = 70%.

**Steals due dates.** Run **Finances › Set Up Steals from the Future…**
once after pasting the updated `Steals.gs`: it adds a `Due Date` column to
the existing `Steals` tab without touching your rows. Put the rollover or
payback date on a Steal row to get the evening-before and morning-of
reminders. Paybacks aren't linked to the Steal they settle, so clear the
Due Date (or move it to the next rollover) once it's handled.

**Trying them without sending** (bearer = `PUSH_NOTIFY_SECRET`):

```sh
curl -s -X POST https://mnab-dashboard.vercel.app/api/push \
  -H "Authorization: Bearer $PUSH_NOTIFY_SECRET" -H 'Content-Type: application/json' \
  -d '{"action":"evening","dryRun":true}'
curl -s -X POST https://mnab-dashboard.vercel.app/api/push \
  -H 'Content-Type: application/json' -d '{"action":"budget-check","dryRun":true}'
```

## How it fits together

```
EmailImport.gs ──(1 POST per run, bearer secret)──▶ /api/push action=notify
                                                       │ reads PushSubscriptions tab
                                                       │ signs (VAPID) + encrypts each message
                                                       ▼
                                   Apple / Google push service ──▶ device ──▶ sw.js shows it
```

- **Devices** subscribe from the bell on the home page (`shared/push.js`). Each
  one is a row in the `PushSubscriptions` tab, created automatically on first
  use. A device that goes away (the app is removed, or permission is revoked)
  is cleared from the tab the next time a send to it fails with 404/410.
- **Sending happens on Vercel, not in Apps Script.** Web Push needs ECDSA
  P-256 signing and payload encryption, and Apps Script has neither.
- **Best effort.** If the notify call fails, the import is unaffected. The
  rows are already in the sheet and the failure is only logged.

## One-time setup

### 1. Vercel environment variables

Settings → Environment Variables. Add these for Production (and Preview if
you want to test there), then redeploy:

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | public key from `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | private key from the same command |
| `VAPID_SUBJECT` | `mailto:` + your email (push services use it to contact you) |
| `PUSH_NOTIFY_SECRET` | any long random string; the same value goes into Apps Script |
| `CRON_SECRET` | any long random string; Vercel sends it to the morning and evening crons. Without it the crons are refused (401) |

Keep the VAPID pair once it's set. Changing it invalidates every existing
subscription, and each device then has to turn notifications on again.

### 2. Apps Script script properties

Project Settings (gear) → Script Properties:

| Key | Value |
|---|---|
| `PUSH_NOTIFY_URL` | `https://mnab-dashboard.vercel.app/api/push` |
| `PUSH_NOTIFY_SECRET` | the same value as in Vercel |

Then deploy the updated `EmailImport.gs`, either with Deployer from your phone
or by pasting it into the editor. To check it end to end, run
`testPushNotification` from the function dropdown and look at the log.

### 3. Turn it on, on each device

On iPhone, notifications only work in the Home Screen app (iOS 16.4+):

1. Open MNAB from its Home Screen icon.
2. Tap the bell next to "Cash Flow" → **Turn on notifications** → Allow.
3. Tap **Send test**.

## Troubleshooting

- **The bell says "Push isn't set up on the server yet".** The VAPID
  variables are missing, or the deploy happened before they were added.
- **The bell says notifications are blocked.** Go to iOS Settings →
  Notifications → MNAB → Allow Notifications.
- **The Apps Script log shows `HTTP 401`.** `PUSH_NOTIFY_SECRET` differs
  between Vercel and Apps Script.
- **The log shows `devices: 0`.** No device has turned notifications on yet,
  or every row in `PushSubscriptions` was cleared.
- **Privacy.** Like the rest of `/api`, subscribing isn't authenticated.
  Anyone who has the dashboard URL could subscribe a device of their own.
  Check the `PushSubscriptions` tab now and then; the Device column shows
  what each row is, and clearing a row removes that device.
