const { test } = require('node:test');
const assert = require('node:assert/strict');

function stubModule(name, exports) {
  const filename = require.resolve(`../src/${name}`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stubModule('llm', { llmEnabled: () => false });
stubModule('discover', { findOfficialWebsiteWithQueries: async () => null });
stubModule('extract', { extractLeaders: () => [] });

const { currentSearchConfig } = require('../src/search-config');
const search = require('../src/search');
const zauba = require('../src/zaubacorp');
const closed = [];
stubModule('search', { ...search, closeSearchBrowser: async () => closed.push('search') });
stubModule('zaubacorp', {
  ...zauba,
  findDirectorsOnZaubaCorp: async (company) => {
    assert.equal(currentSearchConfig().provider, 'searxng');
    return { ok: true, matchedName: company, confidence: 'high', pageUrl: 'https://www.zaubacorp.com/company#director-information', directors: [
      { name: 'Rajesh Kumar Sharma', designation: 'Director', din: '00001234', appointmentDate: '20/09/2006' },
    ] };
  },
  closeZaubaBrowser: async () => closed.push('zauba'),
});
const { runAgent } = require('../src/agent');

test('ZaubaCorp fallback resolves LinkedIn with SearXNG, completes every company, and skips a final delay', async (t) => {
  const companies = ['Alphabrand Foods Limited', 'Betabrand Foods Limited'];
  const origins = [];
  const pauses = [];
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms >= 1500 && ms < 4000) pauses.push(ms);
    return nativeTimeout(callback, ms < 4000 ? 0 : ms, ...args);
  });
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    origins.push(url.origin);
    const q = url.searchParams.get('q') || '';
    const brand = q.includes('alphabrand') ? 'Alphabrand' : 'Betabrand';
    const results = q === 'linkedin' ? [{ url: 'https://www.linkedin.com/', title: 'LinkedIn' }] : q.includes('"Rajesh Sharma"') ? [{
      url: `https://in.linkedin.com/in/rs-${brand.toLowerCase()}`,
      title: 'Rajesh Sharma - Director | LinkedIn', content: `Experience: ${brand} Foods.`,
    }] : [];
    return new Response(JSON.stringify({ results }));
  });
  const progress = [];
  const rows = [];
  const logs = [];
  const meta = {};
  const job = {
    log: (line) => logs.push(line),
    setMeta: (value) => Object.assign(meta, value),
    setProgress: (value) => progress.push({ ...value }),
    onRow: (row) => rows.push(row),
  };
  const result = await runAgent(companies, job, { provider: 'searxng', searxngUrl: 'http://localhost:8080' });
  assert.equal(result.length, 2);
  assert.deepEqual(result, rows);
  assert.ok(rows.every((row) => row.linkedinUrl && row.source === 'ZaubaCorp' && row.status === 'ok_medium'));
  assert.ok(rows.every((row) => row.din === '00001234' && row.appointmentDate === '20/09/2006' && row.sourceUrl.endsWith('#director-information')));
  assert.deepEqual(progress.map((p) => p.completed), [0, 1, 1, 2]);
  assert.equal(progress.at(-1).company, null);
  assert.equal(pauses.length, 1, 'only pause between companies');
  assert.deepEqual(closed, ['search', 'zauba']);
  assert.equal(meta.searchProvider, 'SearXNG');
  assert.ok(origins.length > 1);
  assert.ok(origins.every((origin) => origin === 'http://localhost:8080'));
  assert.ok(logs.every((line) => !/serper/i.test(line)));
});
