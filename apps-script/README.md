# apps-script/

The Apps Script project bound to the MNAB Google Sheet (`Reconcile.gs`, `Templates.gs`, `InstallmentsBills.gs`, `Payments.gs`, `EmailImport.gs`, one shared global namespace, one `onOpen()` menu) has historically lived *outside* this repo — edited directly in the Apps Script editor, with updates delivered to the user as text to paste in by hand. That meant no git history, no PR review, and no diffing for these files.

`EmailImport.gs` is the first of those files brought into this folder for version control (see [#83](https://github.com/maulanna-enoch/mnab-dashboard/issues/83)). It is **not** auto-synced with the live Apps Script project — a change here still has to be pasted into the Apps Script editor by hand after merging. Treat this folder as the versioned source of truth going forward: make changes here first, open a PR, then paste the merged result into the Apps Script editor.

`Reconciliations.gs` (the file elsewhere in this repo's comments — e.g. `api/reconcile.js`, `api/_lib/reconcile.js` — referred to as `Reconcile.gs`; same macro, this is its tracked filename) is the second, current as of v3. Same rules apply: not auto-synced, paste the merged result into the Apps Script editor by hand after merging a change here.

`InstallmentsBills.gs` is the third. Same rules apply: not auto-synced, paste the merged result into the Apps Script editor by hand after merging a change here.

`InboxImport.gs` adds "Import Approved Rows from Inbox…" to the Finances menu. It copies rows you've ticked Approve in the separate **MNAB Import Inbox** spreadsheet into `transactions` and writes each one's destination row back to the inbox, so tools that stage transactions never need access to this spreadsheet. It was written in this repo first. To install it, paste it into the editor as a **new** script file named `InboxImport` (Deployer only replaces files that already exist), then paste the updated `Reconciliations.gs` for the menu item.

The inbox has a **Delete After Import** checkbox per row, ticked by default (a blank cell counts as ticked). After each confirmed run, every ticked row is deleted from the inbox whether or not it was imported, so untick any row you want to keep, including staged rows you haven't reviewed yet. The confirmation says how many rows will be deleted and how many of those weren't imported. If the column is missing, the first run adds it and ticks every existing row. The one row it won't delete is one whose Inbox ID already belongs to a different transaction (for example, an ID reused after the original row was deleted); that row is skipped and kept.

The other bound files (`Templates.gs`, `Payments.gs`) are not yet in this folder. Feel free to add them here the same way when they next need a tracked change.

## Deploying from a phone: `Deployer.gs`

`Deployer.gs` adds a private web page, bound to the same Apps Script project, that does the paste for you. You pick a branch and one tracked file and see a preview. Two taps then write that file into the project. Before writing, it saves a numbered snapshot of the project, and a "Roll back" button restores the file from that snapshot. It only ever replaces one existing file, and leaves everything else (including the untracked `Payments.gs` / `Templates.gs` and the manifest) exactly as it was. It's still a manual deploy and nothing runs on a trigger, in line with the "no automated pushes to the live script" decision.

It needs a one-time setup at a computer: turn on the Apps Script API, paste the file in, add two OAuth scopes to `appsscript.json`, and deploy it as a web app that only you can access. The steps are at the top of the file. `Deployer.gs` itself is not deployable through the page, so update it by hand.
