# apps-script/

The Apps Script project bound to the MNAB Google Sheet (`Reconcile.gs`, `Templates.gs`, `InstallmentsBills.gs`, `Payments.gs`, `EmailImport.gs`, one shared global namespace, one `onOpen()` menu) has historically lived *outside* this repo — edited directly in the Apps Script editor, with updates delivered to the user as text to paste in by hand. That meant no git history, no PR review, and no diffing for these files.

`EmailImport.gs` is the first of those files brought into this folder for version control (see [#83](https://github.com/maulanna-enoch/mnab-dashboard/issues/83)). It is **not** auto-synced with the live Apps Script project — a change here still has to be pasted into the Apps Script editor by hand after merging. Treat this folder as the versioned source of truth going forward: make changes here first, open a PR, then paste the merged result into the Apps Script editor.

`Reconciliations.gs` (the file elsewhere in this repo's comments — e.g. `api/reconcile.js`, `api/_lib/reconcile.js` — referred to as `Reconcile.gs`; same macro, this is its tracked filename) is the second, current as of v3. Same rules apply: not auto-synced, paste the merged result into the Apps Script editor by hand after merging a change here.

`InstallmentsBills.gs` is the third. Same rules apply: not auto-synced, paste the merged result into the Apps Script editor by hand after merging a change here.

The other bound files (`Templates.gs`, `Payments.gs`) are not yet in this folder. Feel free to add them here the same way when they next need a tracked change.
