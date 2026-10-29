# apps-script/

The Apps Script project bound to the MNAB Google Sheet (`Reconcile.gs`, `Templates.gs`, `InstallmentsBills.gs`, `Payments.gs`, `EmailImport.gs`, one shared global namespace, one `onOpen()` menu) has historically lived *outside* this repo — edited directly in the Apps Script editor, with updates delivered to the user as text to paste in by hand. That meant no git history, no PR review, and no diffing for these files.

`EmailImport.gs` is the first of those files brought into this folder for version control (see [#83](https://github.com/maulanna-enoch/mnab-dashboard/issues/83)). It is **not** auto-synced with the live Apps Script project — a change here still has to be pasted into the Apps Script editor by hand after merging. Treat this folder as the versioned source of truth going forward: make changes here first, open a PR, then paste the merged result into the Apps Script editor.

`Reconciliations.gs` (the file elsewhere in this repo's comments — e.g. `api/reconcile.js`, `api/_lib/reconcile.js` — referred to as `Reconcile.gs`; same macro, this is its tracked filename) is the second, current as of v3. Same rules apply: not auto-synced, paste the merged result into the Apps Script editor by hand after merging a change here.

`InstallmentsBills.gs` is the third. Same rules apply: not auto-synced, paste the merged result into the Apps Script editor by hand after merging a change here.

The other bound files (`Templates.gs`, `Payments.gs`) are not yet in this folder. Feel free to add them here the same way when they next need a tracked change.

## Deploying from a phone: `Deployer.gs`

`Deployer.gs` adds a private web page, bound to the same Apps Script project, that does the paste for you. You pick a branch and one tracked file and see a preview. Two taps then write that file into the project. Before writing, it saves a numbered snapshot of the project, and a "Roll back" button restores the file from that snapshot. It only ever replaces one existing file, and leaves everything else (including the untracked `Payments.gs` / `Templates.gs` and the manifest) exactly as it was. It's still a manual deploy and nothing runs on a trigger, in line with the "no automated pushes to the live script" decision.

It needs a one-time setup at a computer: turn on the Apps Script API, paste the file in, add two OAuth scopes to `appsscript.json`, and deploy it as a web app that only you can access. The steps are at the top of the file. `Deployer.gs` itself is not deployable through the page, so update it by hand.

## Logging receipts from an iPhone: `ShortcutImport.gs`

`ShortcutImport.gs` is the exception to everything above: it does **not** go into the Sheet's bound project. It's a web app for the "Log to MNAB" iOS Shortcut (a receipt screenshot goes in, Claude reads it, and a Pending row lands in `transactions`), and the Shortcut can't sign in to Google, so it has to be deployed with access "Anyone". One project shares one `doGet`/`doPost` across all its deployments, so putting it in the bound project would put `Deployer.gs`'s page and every other public function behind a public URL. Instead it lives in its own standalone Apps Script project and opens the Sheet by ID. The few helpers it needs from `EmailImport.gs` and `Reconciliations.gs` are copied into it (prefixed `sc`/`SC_`). If you add a card to `MANDIRI_SOF_MAP` / `OCBC_SOF_MAP`, add it to the `SC_` copies too.

It isn't in `DEPLOYABLE_FILES` and `Deployer.gs` can't reach it, since that only edits the bound project. Update it by pasting into its own project, then create a **new version** of its web-app deployment (Deploy → Manage deployments), or the `/exec` URL keeps serving the old code. Setup is at the top of the file. Building the Shortcut is covered in [`ShortcutImport-iOS-Shortcut.md`](ShortcutImport-iOS-Shortcut.md).
