const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withSearchConfig } = require('../src/search-config');
const { searchWeb, runSearxng } = require('../src/search');

const sx = { provider: 'searxng', searxngUrl: 'http://localhost:8080' };
const json = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

for (const filtered of [false, true]) {
  test(`${filtered ? 'filtered-out' : 'empty'} searches recover on a later job instead of caching NULL`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (input) => {
      assert.equal(new URL(input).origin, 'http://localhost:8080');
      calls++;
      return json({ results: calls === 1
        ? (filtered ? [{ url: 'https://example.test/unrelated', title: 'Unrelated result' }] : [])
        : [{ url: 'https://in.linkedin.com/in/arnav-jain', title: 'Arnav Jain', content: 'Plasmagen Biosciences' }],
      });
    });
    const query = `site:linkedin.com/in Arnav Jain recovery ${filtered}`;
    assert.deepEqual(await withSearchConfig(sx, () => searchWeb(query)), []);
    const recovered = await withSearchConfig(sx, () => searchWeb(query));
    assert.equal(recovered[0].url, 'https://in.linkedin.com/in/arnav-jain');
    assert.equal(calls, 2);
  });
}

test('successful cached results expire so stale evidence can be refreshed', async (t) => {
  let now = Date.now();
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(new URL(input).origin, 'http://localhost:8080');
    calls++;
    return json({ results: [{ url: `https://example.test/revision-${calls}`, title: 'Company evidence' }] });
  });
  const query = 'positive cache expiry recovery';
  const run = () => withSearchConfig(sx, () => searchWeb(query));
  assert.equal((await run())[0].url, 'https://example.test/revision-1');
  now += 9 * 60 * 1000;
  assert.equal((await run())[0].url, 'https://example.test/revision-1');
  assert.equal(calls, 1);
  now += 2 * 60 * 1000;
  assert.equal((await run())[0].url, 'https://example.test/revision-2');
  assert.equal(calls, 2);
});

test('SearXNG rejects Bing first-word noise without discarding Google profile evidence', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ results: [
    { url: 'https://example.test/blue', title: 'Blue - Color', content: 'The color blue', engine: 'bing' },
    { url: 'https://example.test/coffee', title: 'Blue Tokai Coffee Roasters', content: 'Official website', engines: ['bing'] },
    { url: 'https://linkedin.com/in/asha-rao', title: 'Asha Rao - Director', content: 'Blue Tokai', engines: ['google'] },
  ] }));
  const results = await withSearchConfig(sx, () => runSearxng('Blue Tokai Coffee Roasters'));
  assert.deepEqual(results.map((r) => r.url), ['https://example.test/coffee', 'https://linkedin.com/in/asha-rao']);
});

test('Bing results must respect quoted company and site constraints', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ results: [
    { url: 'https://example.test/times', title: 'Times news', content: 'Times Comtrade Private Limited', engine: 'bing' },
    { url: 'https://www.zaubacorp.com/unrelated', title: 'Times Industries Limited', engine: 'bing' },
    { url: 'https://www.zaubacorp.com/matched', title: 'Times Comtrade Private Limited', engine: 'bing' },
  ] }));
  const results = await withSearchConfig(sx, () => runSearxng('site:zaubacorp.com "Times Comtrade Private Limited"'));
  assert.deepEqual(results.map((r) => r.url), ['https://www.zaubacorp.com/matched']);
});

test('duplicate profiles retain the richer company snippet', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ results: [
    { url: 'https://in.linkedin.com/in/arnav-jain', title: 'Arnav Jain | LinkedIn', content: '', engine: 'google' },
    { url: 'https://in.linkedin.com/in/arnav-jain?tracking=1', title: 'Arnav Jain - CFO', content: 'Experience: Plasmagen Biosciences', engine: 'google' },
  ] }));
  const results = await withSearchConfig(sx, () => runSearxng('Arnav Jain Plasmagen'));
  assert.equal(results.length, 1);
  assert.equal(results[0].snippet, 'Experience: Plasmagen Biosciences');
});

test('upstream CAPTCHA details are logged even when another engine returns results', async (t) => {
  const logs = [];
  t.mock.method(globalThis, 'fetch', async () => json({ results: [
    { url: 'https://linkedin.com/in/asha-rao', title: 'Asha Rao', content: 'Acme Director', engine: 'bing' },
  ], unresponsive_engines: [['google', 'CAPTCHA']] }));
  const results = await withSearchConfig(sx, () => runSearxng('Acme Director', { log: (line) => logs.push(line) }));
  assert.equal(results.length, 1);
  assert.ok(logs.some((line) => line.includes('google: CAPTCHA')));
});

test('merging duplicate snippets also preserves the title containing the employer', async (t) => {
  const { validateLinkedInCandidate } = require('../src/linkedin');
  t.mock.method(globalThis, 'fetch', async () => json({ results: [
    { url: 'https://in.linkedin.com/in/arnav-j-8a4b21', title: 'Arnav Jain - CFO - Plasmagen Biosciences', content: 'Investor relations', engine: 'google' },
    { url: 'https://in.linkedin.com/in/arnav-j-8a4b21', title: 'Arnav Jain | LinkedIn', content: 'Arnav Jain is a finance professional', engine: 'bing' },
  ] }));
  const [result] = await withSearchConfig(sx, () => runSearxng('Arnav Jain'));
  assert.equal(result.title, 'Arnav Jain - CFO - Plasmagen Biosciences');
  assert.match(result.snippet, /Investor relations/);
  assert.match(result.snippet, /finance professional/);
  assert.ok(validateLinkedInCandidate(result.url, result.title, 'Arnav Jain', 'Plasmagen Biosciences', result.snippet) > 0);
});
