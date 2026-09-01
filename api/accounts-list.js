const { fetchAccountRows } = require('./_lib/sheets');
const { getSheetsClient, getLastReconciledTimestamps } = require('./_lib/reconcile');

module.exports = async (req, res) => {
  try {
    const [accounts, lastReconciledByName] = await Promise.all([
      fetchAccountRows(),
      getLastReconciledTimestamps(getSheetsClient()),
    ]);
    // lastReconciledAt is an ISO timestamp (when the reconciliation action was
    // logged), not a statement date -- see accounts/index.html's
    // lastReconciledLabel() for how it's turned into "Today"/"Yesterday"/etc.
    const accountsWithReconciled = accounts.map((a) => ({
      ...a,
      lastReconciledAt: lastReconciledByName[String(a.name).trim().toLowerCase()] || null,
    }));
    // No caching: lastReconciledAt (and the balances shown alongside it) must
    // reflect the current sheet state every time the accounts page opens --
    // an s-maxage here previously let Vercel's edge cache serve up to a few
    // minutes of stale post-reconciliation data.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ accounts: accountsWithReconciled, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
