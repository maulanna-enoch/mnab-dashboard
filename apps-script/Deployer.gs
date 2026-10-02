/**
 * Deployer.gs — update this Apps Script project from GitHub, from a phone.
 *
 * The bound Apps Script project is only ever updated by hand (see
 * apps-script/README.md), and the Apps Script editor is close to unusable
 * on a phone. This file adds a small private web page that does the paste
 * for you: pick a branch and ONE tracked file, preview what would change,
 * then confirm. Still manual, still one deliberate tap per deploy — it is
 * NOT an auto-sync, and nothing here runs on a trigger.
 *
 * What a deploy does, in order:
 *   1. Resolves the branch to a commit SHA on GitHub and downloads that one
 *      file at that exact commit (the repo is public, so no token needed).
 *      The preview is pinned to that SHA, so what you confirm is exactly
 *      what gets written even if the branch moves in between.
 *   2. Creates a numbered Apps Script VERSION of the project as it is right
 *      now — a full snapshot to roll back to.
 *   3. Reads the project's current files, replaces the source of that ONE
 *      file, and writes the whole set back (the Apps Script API only has a
 *      "replace everything" call, so every other file — including the
 *      untracked Payments.gs/Templates.gs and appsscript.json — is sent back
 *      exactly as it was read).
 * "Roll back" restores just that file from the snapshot taken in step 2.
 *
 * Only files listed in DEPLOYABLE_FILES can be deployed, and only onto a
 * file that already exists in the project under the mapped name — it never
 * creates, renames or deletes files. Deployer itself is deliberately not in
 * the list: update it by hand, so a bad deploy can't break the tool you'd
 * use to roll back.
 *
 * ── ONE-TIME SETUP (at a computer) ──────────────────────────────────────
 * 1. Turn on the Apps Script API for your account:
 *    https://script.google.com/home/usersettings → "Google Apps Script API"
 *    → On.
 * 2. Paste this file into the Apps Script editor as a new script file named
 *    "Deployer". Save.
 * 3. Add two OAuth scopes to the manifest. This is the one fiddly step:
 *    a. Project Settings (gear) → tick "Show 'appsscript.json' manifest
 *       file in editor".
 *    b. Project Overview (the "i" icon) → under "Project OAuth Scopes",
 *       note every scope listed. These are what the project uses today.
 *    c. In appsscript.json, add (or extend) an "oauthScopes" array with
 *       ALL of those scopes PLUS these two:
 *         "https://www.googleapis.com/auth/script.projects"
 *         "https://www.googleapis.com/auth/script.external_request"
 *       Once "oauthScopes" exists, Apps Script stops detecting scopes on
 *       its own — a scope you leave out (Gmail, Sheets, triggers…) will
 *       break the feature that needs it. Copy the full list from step b.
 *    d. Save.
 * 4. Deploy → New deployment → type "Web app". Execute as: Me. Who has
 *    access: Only myself. Deploy, authorize, and copy the /exec URL.
 * 5. Open that URL on your phone and add it to your home screen.
 *
 * If the editor-side name of a file differs from the default mapping below
 * (e.g. Reconciliations.gs is called "Reconcile" in the editor), fix the
 * mapping here. The page lists the project's actual file names if a target
 * isn't found.
 *
 * Note: the web app runs the Deployer code that was current when you made
 * the deployment (step 4). Code you deploy THROUGH it takes effect
 * immediately for menus, triggers and macros — those always run the latest
 * saved code.
 */

var DEPLOYER_REPO = 'maulanna-enoch/mnab-dashboard';

// repo path → name of the file in the Apps Script editor (no extension).
var DEPLOYABLE_FILES = {
  'apps-script/EmailImport.gs': 'EmailImport',
  'apps-script/InstallmentsBills.gs': 'InstallmentsBills',
  'apps-script/Reconciliations.gs': 'Reconcile'
};

var DEPLOYER_LAST_BACKUP_KEY = 'DEPLOYER_LAST_BACKUP';

function doGet() {
  return HtmlService.createHtmlOutput(deployerPageHtml_())
      .setTitle('MNAB Deploy')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ── server calls (from the page via google.script.run) ─────────────────

function deployerListFiles() {
  return {
    files: Object.keys(DEPLOYABLE_FILES),
    lastBackup: deployerLastBackup_()
  };
}

// Pins `branch` to a commit and compares that commit's copy of `repoPath`
// with what's in the project now. Writes nothing.
function deployerPreview(branch, repoPath) {
  var target = deployerTargetName_(repoPath);
  var commit = deployerResolveCommit_(branch);
  var incoming = deployerFetchFile_(commit.sha, repoPath);

  var files = deployerGetContent_();
  var current = deployerFindFile_(files, target);

  return {
    branch: branch,
    repoPath: repoPath,
    target: target,
    sha: commit.sha,
    commitMessage: commit.message,
    commitDate: commit.date,
    incomingHash: deployerHash_(incoming),
    identical: current.source === incoming,
    stats: deployerDiffStats_(current.source, incoming)
  };
}

// Writes the previewed file. `sha` and `expectedHash` come from the
// preview, so a deploy can only ever write the exact bytes that were shown.
function deployerDeploy(repoPath, sha, expectedHash) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error('Bad commit SHA — run Preview again.');
  var target = deployerTargetName_(repoPath);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) throw new Error('Another deploy is running. Try again in a minute.');
  try {
    var incoming = deployerFetchFile_(sha, repoPath);
    if (deployerHash_(incoming) !== expectedHash) {
      throw new Error('The file downloaded now does not match the preview. Nothing was changed — run Preview again.');
    }

    var files = deployerGetContent_();
    var current = deployerFindFile_(files, target);
    if (current.source === incoming) return { unchanged: true, target: target };

    var version = deployerCreateVersion_('Before deploying ' + repoPath + ' @ ' + sha.substring(0, 7));

    current.source = incoming;
    deployerPutContent_(files);

    // Read back and check, rather than trusting the PUT's status alone.
    var after = deployerFindFile_(deployerGetContent_(), target);
    if (after.source !== incoming) {
      throw new Error('Wrote the file but reading it back gave different contents. Use Roll back (snapshot v' + version + ').');
    }

    var backup = {
      version: version,
      target: target,
      repoPath: repoPath,
      sha: sha,
      at: new Date().toISOString()
    };
    PropertiesService.getScriptProperties().setProperty(DEPLOYER_LAST_BACKUP_KEY, JSON.stringify(backup));
    return { unchanged: false, target: target, backup: backup };
  } finally {
    lock.releaseLock();
  }
}

// Restores ONLY the last deployed file from the snapshot taken just before
// that deploy. Other files are left as they are now.
function deployerRollback() {
  var backup = deployerLastBackup_();
  if (!backup) throw new Error('No deploy to roll back.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) throw new Error('Another deploy is running. Try again in a minute.');
  try {
    var old = deployerFindFile_(deployerGetContent_(backup.version), backup.target);
    var files = deployerGetContent_();
    deployerFindFile_(files, backup.target).source = old.source;
    deployerPutContent_(files);
    PropertiesService.getScriptProperties().deleteProperty(DEPLOYER_LAST_BACKUP_KEY);
    return { target: backup.target, version: backup.version };
  } finally {
    lock.releaseLock();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function deployerTargetName_(repoPath) {
  if (!Object.prototype.hasOwnProperty.call(DEPLOYABLE_FILES, repoPath)) {
    throw new Error(repoPath + ' is not in DEPLOYABLE_FILES.');
  }
  return DEPLOYABLE_FILES[repoPath];
}

function deployerLastBackup_() {
  var raw = PropertiesService.getScriptProperties().getProperty(DEPLOYER_LAST_BACKUP_KEY);
  return raw ? JSON.parse(raw) : null;
}

function deployerResolveCommit_(branch) {
  if (!/^[A-Za-z0-9._\/-]+$/.test(String(branch))) throw new Error('Invalid branch name.');
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + DEPLOYER_REPO + '/commits/' + encodeURIComponent(branch), {
    headers: { Accept: 'application/vnd.github+json' },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('GitHub could not find branch "' + branch + '" (HTTP ' + res.getResponseCode() + ').');
  }
  var c = JSON.parse(res.getContentText());
  return {
    sha: c.sha,
    message: String(c.commit.message).split('\n')[0],
    date: c.commit.committer && c.commit.committer.date
  };
}

function deployerFetchFile_(sha, repoPath) {
  var res = UrlFetchApp.fetch('https://raw.githubusercontent.com/' + DEPLOYER_REPO + '/' + sha + '/' + repoPath, {
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(repoPath + ' was not found at commit ' + sha.substring(0, 7) + ' (HTTP ' + res.getResponseCode() + ').');
  }
  var text = res.getContentText('UTF-8');
  if (!text.trim()) throw new Error(repoPath + ' is empty at that commit — refusing to deploy it.');
  return text;
}

function deployerApi_(method, path, body) {
  var opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    contentType: 'application/json',
    muteHttpExceptions: true
  };
  if (body) opts.payload = JSON.stringify(body);
  var res = UrlFetchApp.fetch('https://script.googleapis.com/v1/projects/' + ScriptApp.getScriptId() + path, opts);
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    var text = res.getContentText();
    var hint = '';
    if (code === 403 && /has not been used|disabled|User has not enabled/i.test(text)) {
      hint = ' Turn on the Apps Script API at https://script.google.com/home/usersettings (setup step 1).';
    } else if (code === 403 || code === 401) {
      hint = ' Check the script.projects scope in appsscript.json (setup step 3).';
    }
    throw new Error('Apps Script API ' + method + ' ' + path + ' failed (HTTP ' + code + ').' + hint + ' ' + text.substring(0, 300));
  }
  return JSON.parse(res.getContentText() || '{}');
}

function deployerGetContent_(versionNumber) {
  var content = deployerApi_('get', '/content' + (versionNumber ? '?versionNumber=' + versionNumber : ''));
  // Keep only the writable fields — the GET also returns read-only ones
  // (createTime, functionSet, lastModifyUser…).
  return (content.files || []).map(function (f) {
    return { name: f.name, type: f.type, source: f.source };
  });
}

function deployerPutContent_(files) {
  if (!files.some(function (f) { return f.type === 'JSON' && f.name === 'appsscript'; })) {
    throw new Error('Refusing to write: the manifest (appsscript.json) is missing from what was read.');
  }
  deployerApi_('put', '/content', { files: files });
}

function deployerCreateVersion_(description) {
  return deployerApi_('post', '/versions', { description: description.substring(0, 100) }).versionNumber;
}

function deployerFindFile_(files, name) {
  var match = files.filter(function (f) { return f.name === name && f.type === 'SERVER_JS'; })[0];
  if (!match) {
    var names = files.filter(function (f) { return f.type === 'SERVER_JS'; }).map(function (f) { return f.name; });
    throw new Error('No script file named "' + name + '" in this project. Files here: ' + names.join(', ') +
        '. Fix DEPLOYABLE_FILES in Deployer.gs.');
  }
  return match;
}

function deployerHash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
      .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
      .join('');
}

// Cheap line-level summary: lines before/after, and how many lines differ
// once the shared head and tail are trimmed off. Not a real diff — the
// GitHub PR is the place to read the change itself.
function deployerDiffStats_(oldText, newText) {
  var a = String(oldText || '').split('\n');
  var b = String(newText).split('\n');
  var start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  var endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  return {
    oldLines: a.length,
    newLines: b.length,
    removed: Math.max(0, endA - start + 1),
    added: Math.max(0, endB - start + 1),
    firstChangedLine: start + 1
  };
}

// ── page ────────────────────────────────────────────────────────────────

function deployerPageHtml_() {
  return [
    '<!doctype html><html><head><base target="_top"><style>',
    ':root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--accent:#1a73e8;--ok:#188038;--bad:#c5221f;--card:#f6f7f9}',
    '@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--muted:#aaa;--line:#333;--accent:#8ab4f8;--ok:#81c995;--bad:#f28b82;--card:#1e1e1e}}',
    'body{margin:0;padding:16px;font:16px/1.45 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg)}',
    'h1{font-size:20px;margin:0 0 12px}label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}',
    'input,select{width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}',
    'button{width:100%;padding:12px;margin-top:12px;font-size:16px;font-weight:600;border:0;border-radius:8px;background:var(--accent);color:#fff}',
    'button.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}button:disabled{opacity:.5}',
    '.card{background:var(--card);border-radius:10px;padding:12px;margin-top:16px;word-break:break-word}',
    '.ok{color:var(--ok)}.bad{color:var(--bad)}.muted{color:var(--muted);font-size:13px}code{font-size:13px}',
    '</style></head><body>',
    '<h1>MNAB Deploy</h1>',
    '<label for="branch">Branch</label><input id="branch" value="main" autocapitalize="off" autocorrect="off">',
    '<label for="file">File</label><select id="file"></select>',
    '<button id="preview">Preview</button>',
    '<div id="out"></div><div id="backup"></div>',
    '<script>',
    'var $=function(id){return document.getElementById(id)};var current=null;',
    'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}',
    'function twoTap(btn,label,fn){btn.onclick=function(){if(btn.dataset.armed){fn();return}btn.dataset.armed=1;btn.textContent=label;setTimeout(function(){delete btn.dataset.armed},6000)}}',
    'function busy(b){Array.prototype.forEach.call(document.querySelectorAll("button"),function(x){x.disabled=b})}',
    'function fail(e){busy(false);$("out").innerHTML="<div class=card><b class=bad>Error</b><br>"+esc(e&&e.message||e)+"</div>"}',
    'function showBackup(b){$("backup").innerHTML=b?"<div class=card><b>Last deploy</b><br><code>"+esc(b.target)+"</code> from <code>"+esc(b.sha.slice(0,7))+"</code><br><span class=muted>"+esc(b.at)+" · snapshot v"+esc(b.version)+"</span><button class=secondary id=rollback>Roll back "+esc(b.target)+"</button></div>":"";',
    ' if(b)twoTap($("rollback"),"Tap again to restore "+b.target,function(){busy(true);google.script.run.withFailureHandler(fail).withSuccessHandler(function(r){busy(false);$("out").innerHTML="<div class=card><b class=ok>Rolled back</b> "+esc(r.target)+" to snapshot v"+esc(r.version)+".</div>";showBackup(null)}).deployerRollback()})}',
    'google.script.run.withFailureHandler(fail).withSuccessHandler(function(r){$("file").innerHTML=r.files.map(function(f){return"<option>"+esc(f)+"</option>"}).join("");showBackup(r.lastBackup)}).deployerListFiles();',
    '$("preview").onclick=function(){busy(true);$("out").innerHTML="<div class=card><span class=muted>Checking GitHub…</span></div>";',
    ' google.script.run.withFailureHandler(fail).withSuccessHandler(function(p){busy(false);current=p;var s=p.stats;',
    '  var h="<div class=card><b>"+esc(p.repoPath)+"</b> → <code>"+esc(p.target)+"</code><br>"+esc(p.branch)+" @ <code>"+esc(p.sha.slice(0,7))+"</code> — "+esc(p.commitMessage)+"<br><span class=muted>"+esc(p.commitDate)+"</span><br><br>";',
    '  if(p.identical){h+="<b class=ok>Already up to date.</b> Nothing to deploy.</div>"}',
    '  else{h+="Lines: "+s.oldLines+" → "+s.newLines+"<br>Changed region from line "+s.firstChangedLine+": <span class=bad>−"+s.removed+"</span> <span class=ok>+"+s.added+"</span><button id=deploy>Deploy to Apps Script</button></div>"}',
    '  $("out").innerHTML=h;if(!p.identical)twoTap($("deploy"),"Tap again to replace "+p.target,function(){busy(true);',
    '   google.script.run.withFailureHandler(fail).withSuccessHandler(function(r){busy(false);$("out").innerHTML=r.unchanged?"<div class=card><b class=ok>Already up to date.</b></div>":"<div class=card><b class=ok>Deployed.</b> "+esc(r.target)+" now matches <code>"+esc(r.backup.sha.slice(0,7))+"</code>. Saved snapshot v"+esc(r.backup.version)+" first.</div>";if(r.backup)showBackup(r.backup)}).deployerDeploy(p.repoPath,p.sha,p.incomingHash)})',
    ' }).deployerPreview($("branch").value.trim(),$("file").value)};',
    '</script></body></html>'
  ].join('\n');
}
