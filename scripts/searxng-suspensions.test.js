const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withSearchConfig } = require('../src/search-config');
const { runSearxng, searchWeb, searchWithFallbackQueries, verifySearchProvider } = require('../src/search');

const config = (name) => ({ provider: 'searxng', searxngUrl: `http://localhost:8080/${name}` });
const json = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const profile = {
  url: 'https://in.linkedin.com/in/sethu-madhavan-sankaran-983b536',
  title: 'Sethu Madhavan Sankaran - PlasmaGen BioSciences (P) Ltd | LinkedIn',
  content: 'COO at PlasmaGen Biosciences', engine: 'bing',
};

test('only selected web engines run; suspended Google is skipped with one warning per job', async (t) => {
  const requests = [];
  const logs = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'http://localhost:8080');
    assert.equal(url.searchParams.has('categories'), false, 'Wikipedia and other category engines must not be added');
    requests.push(url.searchParams.get('engines'));
    return json({ results: [profile], unresponsive_engines: requests.length === 1
      ? [['google', 'Suspended: CAPTCHA'], ['wikipedia', 'Suspended: HTTP error']] : [] });
  });
  await withSearchConfig(config('one-warning'), async () => {
    for (let i = 0; i < 3; i++) {
      const results = await runSearxng('Plasmagen Biosciences Sethu Madhavan', { log: (line) => logs.push(line) });
      assert.equal(results[0].url, profile.url);
    }
  });
  assert.deepEqual(requests, ['google,bing', 'bing', 'bing']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /google: CAPTCHA/);
  assert.ok(logs.every((line) => !/wikipedia/i.test(line)));
  await withSearchConfig(config('one-warning'), () => runSearxng('Plasmagen Biosciences Sethu Madhavan', { log: (line) => logs.push(line) }));
  assert.equal(logs.length, 2, 'a later job is informed that its results may be incomplete');
});

test('CAPTCHA plus unrelated Bing results produces unavailable after trying remaining engines', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'http://localhost:8080', 'no Serper or scraper requests during upstream suspension');
    requests.push(url.searchParams.get('q'));
    assert.equal(url.searchParams.get('engines'), requests.length === 1 ? 'google,bing' : 'bing');
    return json({ results: [{ url: 'https://www.plasmagen.com', title: 'PlasmaGen Biosciences', engine: 'bing' }],
      unresponsive_engines: [['google', 'Suspended: CAPTCHA']] });
  });
  await assert.rejects(withSearchConfig(config('unavailable'), () => searchWithFallbackQueries(() => [
    'Plasmagen Biosciences Sethu Madhavan',
    'site:linkedin.com/in "Sethu Madhavan" "Plasmagen Biosciences"',
  ])), { code: 'SEARCH_UNAVAILABLE' });
  assert.equal(requests.length, 2);
});

test('a later query can recover the profile through a remaining engine while Google stays suspended', async (t) => {
  const engines = [];
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => nativeTimeout(fn, ms < 2000 ? 0 : ms, ...args));
  t.mock.method(globalThis, 'fetch', async (input) => {
    engines.push(new URL(input).searchParams.get('engines'));
    return engines.length === 1
      ? json({ results: [], unresponsive_engines: [['google', 'CAPTCHA']] })
      : json({ results: [profile] });
  });
  const results = await withSearchConfig(config('remaining-recovers'), () => searchWithFallbackQueries(() => [
    'Plasmagen Biosciences Sethu Madhavan',
    'site:linkedin.com/in Sethu Madhavan Plasmagen Biosciences',
  ], { accept: (r) => r.url === profile.url, minAccepted: 1 }));
  assert.equal(results[0].url, profile.url);
  assert.deepEqual(engines, ['google,bing', 'bing']);
});

test('all suspended engines are left alone until cooldown expires, then searches recover', async (t) => {
  let now = Date.now();
  let requests = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return requests === 1
      ? json({ results: [], unresponsive_engines: [['google', 'CAPTCHA'], ['bing', 'CAPTCHA']] })
      : json({ results: [profile] });
  });
  const run = () => withSearchConfig(config('expires'), () => searchWeb('Plasmagen Biosciences Sethu Madhavan'));
  await assert.rejects(run(), { code: 'SEARCH_UNAVAILABLE' });
  await assert.rejects(run(), { code: 'SEARCH_UNAVAILABLE' });
  assert.equal(requests, 1);
  now += 60 * 60 * 1000 + 1;
  assert.equal((await run())[0].url, profile.url);
  assert.equal(requests, 2);
});

test('a blocked instance does not disable engines on a different instance', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('engines'), 'google,bing');
    return url.pathname.startsWith('/blocked-instance')
      ? json({ results: [], unresponsive_engines: [['google', 'CAPTCHA']] })
      : json({ results: [profile] });
  });
  await assert.rejects(withSearchConfig(config('blocked-instance'), () => runSearxng('Plasmagen Biosciences Sethu Madhavan')), { code: 'SEARCH_UNAVAILABLE' });
  assert.equal((await withSearchConfig(config('healthy-instance'), () => runSearxng('Plasmagen Biosciences Sethu Madhavan')))[0].url, profile.url);
});

test('connection check discloses a suspended engine even when another engine still works', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ results: [{ url: 'https://www.linkedin.com', title: 'LinkedIn', engine: 'bing' }],
    unresponsive_engines: [['google', 'CAPTCHA']] }));
  const check = await withSearchConfig(config('health-warnings'), verifySearchProvider);
  assert.equal(check.ok, true);
  assert.deepEqual(check.warnings, ['google: CAPTCHA']);
});

test('verified results collected before an outage are retained', async (t) => {
  let requests = 0;
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => nativeTimeout(fn, ms < 2000 ? 0 : ms, ...args));
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? json({ results: [profile] })
    : json({ results: [], unresponsive_engines: [['google', 'CAPTCHA'], ['bing', 'CAPTCHA']] }));
  const results = await withSearchConfig(config('retain-evidence'), () => searchWithFallbackQueries(() => [
    'Plasmagen Biosciences Sethu Madhavan', 'Plasmagen Biosciences Sethu Madhavan LinkedIn',
  ], { accept: (r) => r.url === profile.url, minAccepted: 2 }));
  assert.equal(results[0].url, profile.url);
  assert.equal(requests, 2);
});
