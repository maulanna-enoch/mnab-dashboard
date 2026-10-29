# "Log to MNAB" iOS Shortcut

Open a transaction receipt in your banking app, run the Shortcut, and a **Pending** row lands in `transactions` a few seconds later. The server side is [`ShortcutImport.gs`](ShortcutImport.gs), which runs as its **own standalone Apps Script project**, not inside the Sheet's bound project. Set that up first (see its header), and have its `/exec` web-app URL and your `SHORTCUT_TOKEN` ready.

## Build the Shortcut

In the Shortcuts app, tap **+**, name it **Log to MNAB**, then add these actions in order:

| # | Action | Settings |
|---|---|---|
| 1 | **Take Screenshot** | — |
| 2 | **Resize Image** | Resize *Screenshot* to Width **1000** (leave Height as Auto) |
| 3 | **Convert Image** | Convert *Resized Image* to **JPEG**, Quality ~**70%**, Preserve Metadata **off** |
| 4 | **Base64 Encode** | Encode *Converted Image*, Line Breaks **None** (tap the arrow to show it) |
| 5 | **Get Contents of URL** | URL: your `/exec` URL. Tap the arrow: Method **POST**, Request Body **JSON**, then add fields ↓ |
| 6 | **Get Dictionary Value** | Get Value for **message** in *Contents of URL* |
| 7 | **Show Notification** | Body: *Dictionary Value* (Title: "MNAB") |

Fields for step 5 (Request Body → JSON → Add new field):

| Key | Type | Value |
|---|---|---|
| `token` | Text | your `SHORTCUT_TOKEN` |
| `image` | Text | *Base64 Encoded* (the magic variable from step 4) |
| `dryRun` | Boolean | **True** for your first few tests, then delete the field or set it to False |
| `sof` | Text | *optional*. An exact Accounts name, to force the account (e.g. a separate "Log to MNAB – Jago" Shortcut) |

With `dryRun` on, the notification starts with **[Test] Would add:** and nothing is written. Check a couple of receipts from each bank that way before switching it off.

## Running it

- **Siri:** "Hey Siri, Log to MNAB" while the receipt is on screen.
- **Back Tap (fastest):** Settings → Accessibility → Touch → Back Tap → Double Tap → *Log to MNAB*.
- **Action Button / Control Center** also work on phones that have them.

Whichever way you trigger it, the receipt has to be what's on screen at that moment. The screenshot captures everything visible, so only run it on the receipt screen.

## What you'll see

- `Added (pending): Rp 45.000 · Kopi Kenangan · ocbc 90.N · 28/09/2026`, plus `· possible match with a manual entry` if you'd already typed it in by hand.
- `Already logged: …` if that receipt's reference number is already in the sheet. Nothing is added.
- `no SOF` in the message means the account couldn't be worked out. Pick it when you review the pending row.
- Errors (wrong token, not a receipt, unreadable date) come back as a plain sentence. Nothing is written.

## Troubleshooting

- **The notification shows HTML or "Script function not found: doPost"**: the web app is serving an old version. In Apps Script go to Deploy → Manage deployments → edit → Version: New version → Deploy.
- **"Wrong or missing token"**: the `token` field doesn't match the `SHORTCUT_TOKEN` Script Property exactly.
- **Wrong account**: the card last-4 maps are `SC_MANDIRI_SOF_MAP` / `SC_OCBC_SOF_MAP` in `ShortcutImport.gs`, copies of the ones in `EmailImport.gs`. Add the missing card to both.
