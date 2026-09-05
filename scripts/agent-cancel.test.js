const { test } = require('node:test');
const assert = require('node:assert/strict');

function stubModule(name, exports) {
  const filename = require.resolve(`../src/${name}`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stubModule('llm', { llmEnabled: () => false });
stubModule('discover', { findOfficialWebsiteWithQueries: async () => null });
stubModule('extract', { extractLeaders: () => [] });

const search = require('../src/search');
const zauba = require('../src/zaubacorp');
const closed = [];
stubModule('search', {
  ...search,
  verifySearchProvider: async () => ({ ok: true, credits: null }),
  closeSearchBrowser: async () => closed.push('search'),
});
stubModule('zaubacorp', {
  ...zauba,
  findDirectorsOnZaubaCorp: async (company) => ({
    ok: true, matchedName: company, confidence: 'high', pageUrl: 'https://www.zaubacorp.com/company',
    directors: [{ name: 'Asha Rao', designation: 'Director' }],
  }),
  verifyDirectorOnLinkedIn: async () => ({ url: null, confidence: 'none', reason: 'not found' }),
  closeZaubaBrowser: async () => closed.push('zauba'),
});
const { runAgent } = require('../src/agent');

/** A job that behaves like the server's: cancellable, with waiters to wake. */
function makeJob(cancelAfterRows) {
  const waiters = new Set();
  return {
    cancelled: false,
    rows: [],
    logs: [],
    progress: [],
    pauses: [],
    log(line) { this.logs.push(line); },
    setMeta() {},
    setProgress(value) { this.progress.push({ ...value }); },
    onRow(row) {
      this.rows.push(row);
      if (this.rows.length >= cancelAfterRows) this.cancel();
    },
    onCancel(fn) { if (this.cancelled) fn(); else waiters.add(fn); },
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      for (const fn of waiters) fn();
      waiters.clear();
    },
  };
}

test('a cancelled run stops between companies and returns the rows collected so far', async (t) => {
  const nativeTimeout = globalThis.setTimeout;
  const pauses = [];
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms >= 1500 && ms < 4000) pauses.push(ms);
    return nativeTimeout(callback, ms < 4000 ? 0 : ms, ...args);
  });

  const job = makeJob(1);
  const rows = await runAgent(['Alphabrand Foods Limited', 'Betabrand Foods Limited', 'Gammabrand Foods Limited'], job, {
    provider: 'searxng', searxngUrl: 'http://localhost:8080',
  });

  assert.equal(rows.length, 1, 'only the company in flight when cancel arrived produces rows');
  assert.deepEqual(rows.map((row) => row.companyName), ['Alphabrand Foods Limited']);
  assert.deepEqual(rows, job.rows);
  assert.equal(pauses.length, 0, 'a cancelled run must not sit out the inter-company pause');
  assert.ok(job.logs.some((line) => line.includes('Cancelled - stopped after 1 of 3 companies')));
  assert.deepEqual(closed, ['search', 'zauba'], 'browsers still close on the way out');
});

test('an uncancelled job without cancel support runs every company', async (t) => {
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) =>
    nativeTimeout(callback, ms < 4000 ? 0 : ms, ...args));

  const rows = [];
  const job = {
    log() {}, setMeta() {}, setProgress() {}, onRow: (row) => rows.push(row),
  };
  const result = await runAgent(['Alphabrand Foods Limited', 'Betabrand Foods Limited'], job, {
    provider: 'searxng', searxngUrl: 'http://localhost:8080',
  });
  assert.equal(result.length, 2, 'a plain job object has no cancel flag and must not stop early');
});
