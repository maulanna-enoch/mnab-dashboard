# Push notifications setup

When `EmailImport.gs` imports new bank transactions, every device that turned
notifications on gets one push, for example:

- one row: **−Rp150.000 · GoFood**, with *mandiri · Pending review* underneath
- several rows: **3 new transactions**, one line each (up to four, then "+N more")

Tapping it opens Transactions filtered to rows pending review
(`/transactions?pending=1`).

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
