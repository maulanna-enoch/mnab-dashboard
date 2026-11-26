// Coalesces concurrent spreadsheets.values.get calls into one
// spreadsheets.values.batchGet.
//
// Why: the Sheets API quota is 60 read requests per minute per user, and
// every endpoint here reads as the same service account, so it counts as one
// user. A batchGet counts as ONE read request however many ranges it carries,
// so e.g. /api/cashflow-summary?action=debt goes from 8 reads to 1.
//
// How: wrapClient() replaces client.spreadsheets.values.get with a version
// that queues the call and flushes the queue on the next macrotask
// (setImmediate). Everything a handler fires off together -- typically a
// Promise.all of fetchX() helpers, or helpers that each call
// getSheetsClient() themselves -- lands in the same flush. Callers see
// exactly the same `{ data: { range, majorDimension, values } }` shape as
// before, so nothing that calls values.get has to change.
//
// Only reads that were already concurrent are merged, so read-after-write
// ordering in the write endpoints is unchanged: a get awaited after an
// update still runs after it.
//
// A missing tab makes the whole batchGet fail with "Unable to parse range".
// Several fetchers treat a missing tab as normal (Settings, Steals,
// Categories), so on that error the batch falls back to one get per range,
// and each caller gets its own result or its own error, as before.

const BATCHED = Symbol('mnabReadBatched');

function batchKey(params) {
  return JSON.stringify([
    params.spreadsheetId,
    params.valueRenderOption || null,
    params.dateTimeRenderOption || null,
    params.majorDimension || null,
  ]);
}

function wrapClient(client, { onFlush } = {}) {
  const values = client && client.spreadsheets && client.spreadsheets.values;
  if (!values || values[BATCHED]) return client;

  const originalGet = values.get.bind(values);
  const batchGet = values.batchGet.bind(values);
  let queue = new Map(); // batchKey -> { params, entries: [{ range, resolve, reject }] }
  let scheduled = false;

  async function flushGroup({ params, entries }) {
    // Identical ranges in one flush share one slot.
    const ranges = [...new Set(entries.map((e) => e.range))];
    if (onFlush) onFlush({ ranges, params });

    if (ranges.length === 1) {
      try {
        const res = await originalGet({ ...params, range: ranges[0] });
        entries.forEach((e) => e.resolve(res));
      } catch (err) {
        entries.forEach((e) => e.reject(err));
      }
      return;
    }

    let res;
    try {
      res = await batchGet({ ...params, ranges });
    } catch (err) {
      if (!/unable to parse range/i.test(String((err && err.message) || ''))) {
        entries.forEach((e) => e.reject(err));
        return;
      }
      // One of the ranges names a tab that doesn't exist: fall back to one
      // get per range so only that caller sees the error.
      await Promise.all(ranges.map(async (range) => {
        const mine = entries.filter((e) => e.range === range);
        try {
          const single = await originalGet({ ...params, range });
          mine.forEach((e) => e.resolve(single));
        } catch (singleErr) {
          mine.forEach((e) => e.reject(singleErr));
        }
      }));
      return;
    }

    const valueRanges = (res && res.data && res.data.valueRanges) || [];
    ranges.forEach((range, i) => {
      const vr = valueRanges[i] || {};
      const shaped = { ...res, data: { range: vr.range, majorDimension: vr.majorDimension, values: vr.values } };
      entries.filter((e) => e.range === range).forEach((e) => e.resolve(shaped));
    });
  }

  function flush() {
    const groups = [...queue.values()];
    queue = new Map();
    scheduled = false;
    groups.forEach((g) => { flushGroup(g); });
  }

  values.get = function batchedGet(params, ...rest) {
    // Callback / per-call options style isn't used in this app; leave it alone.
    if (rest.length || !params || typeof params.range !== 'string') {
      return originalGet(params, ...rest);
    }
    const { range, ...shared } = params;
    const key = batchKey(shared);
    return new Promise((resolve, reject) => {
      if (!queue.has(key)) queue.set(key, { params: shared, entries: [] });
      queue.get(key).entries.push({ range, resolve, reject });
      if (!scheduled) {
        scheduled = true;
        setImmediate(flush);
      }
    });
  };
  values[BATCHED] = true;
  return client;
}

module.exports = { wrapClient };
