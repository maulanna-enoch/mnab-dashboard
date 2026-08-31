// Payee registry endpoint. Dispatches on `action` the same way
// api/reconcile.js does, rather than adding a sibling file -- Vercel
// Hobby's 12-Serverless-Function cap was already fully used before issue
// #52 (see MNAB-project-state.md).
//
// GET (no action, or ?action=list): read-only. Powers the Payee field's
// autocomplete <datalist> (transaction-form.js) and the Payees management
// page's list view. Reads ONLY from the `Payees` tab -- it no longer
// touches `transactions` at all. `Payees` is now the single source of
// truth for "which payees exist," populated automatically by
// transactions-add.js's upsert on every save (see api/_lib/sheets.js's
// upsertPayee) plus the one-time/rerunnable backfill below.
//
// POST action=set-coords: manual-override write path for the Payees page --
// set (or, by omitting lat/lon, clear) one payee's stored coordinates.
// Also how a payee with no transactions yet gets pre-seeded.
//
// POST action=backfill: seeds `Payees` (existence-only, no coordinates)
// from every distinct payee name already in `transactions` history. Needed
// once after this feature ships, since `Payees` starts empty -- without it
// the autocomplete would show nothing until each payee is used again
// post-migration (same trap as issue #38's Gmail-label backlog). Safe to
// re-run any time -- skips whatever already has a row.
const {
  getSheetsClient,
  getWriteSheetsClient,
  fetchTransactionRows,
  fetchPayeeRows,
  upsertPayee,
  clearPayeeCoords,
} = require('./_lib/sheets');

async function actionList(res) {
  const sheets = getSheetsClient();
  const rows = await fetchPayeeRows(sheets);
  const payees = rows
    .map((r) => ({ name: r.name, lat: r.lat, lon: r.lon }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  res.status(200).json({ payees, updatedAt: new Date().toISOString() });
}

async function actionSetCoords(body, res) {
  const { name, lat, lon } = body || {};
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const sheets = getWriteSheetsClient();
  const clearing = lat === null || lat === undefined || lat === '' || lon === null || lon === undefined || lon === '';

  if (clearing) {
    await clearPayeeCoords(sheets, name);
    res.status(200).json({ ok: true, cleared: true });
    return;
  }

  const numLat = Number(lat);
  const numLon = Number(lon);
  if (!Number.isFinite(numLat) || numLat < -90 || numLat > 90) {
    res.status(400).json({ error: 'lat must be a number between -90 and 90' });
    return;
  }
  if (!Number.isFinite(numLon) || numLon < -180 || numLon > 180) {
    res.status(400).json({ error: 'lon must be a number between -180 and 180' });
    return;
  }

  await upsertPayee(sheets, { name, lat: numLat, lon: numLon });
  res.status(200).json({ ok: true, cleared: false });
}

async function actionBackfill(res) {
  const sheets = getWriteSheetsClient();
  const [txnRows, payeeRows] = await Promise.all([
    fetchTransactionRows(),
    fetchPayeeRows(sheets),
  ]);

  const existingKeys = new Set(payeeRows.map((r) => r.name.trim().toLowerCase()));
  const seen = new Set();
  const toAdd = [];
  txnRows.forEach((r) => {
    const name = (r.payee || '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (existingKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    toAdd.push(name);
  });

  // Sequential, not Promise.all -- each upsertPayee does its own
  // read-then-write against the same tab, and running them concurrently
  // would race (two inserts could both read "not found yet" and append
  // duplicate rows for the same payee).
  for (const name of toAdd) {
    await upsertPayee(sheets, { name });
  }

  res.status(200).json({ ok: true, added: toAdd.length, alreadyPresent: existingKeys.size });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const action = (req.query && req.query.action) || 'list';
      if (action === 'list') return await actionList(res);
      res.status(400).json({ error: 'Unknown GET action. Use ?action=list (or omit action).' });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Use GET or POST' });
      return;
    }

    const action = req.body && req.body.action;
    switch (action) {
      case 'set-coords':
        return await actionSetCoords(req.body, res);
      case 'backfill':
        return await actionBackfill(res);
      default:
        res.status(400).json({ error: 'Unknown or missing action. Use one of: set-coords, backfill.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
