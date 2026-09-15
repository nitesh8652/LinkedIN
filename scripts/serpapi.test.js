const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withSearchConfig, currentSearchConfig, searchProviderLabel } = require('../src/search-config');
const { searchWeb, searchWithFallbackQueries, verifySearchProvider, verifySerperKey } = require('../src/search');
const { runSerpapi, serpapiStatus } = require('../src/serpapi');
const { parseDirectorsFromSearchResults, verifyDirectorOnLinkedIn } = require('../src/zaubacorp');
const { runAgent } = require('../src/agent');

process.env.SERPAPI_API_KEY = 'serpapi-offline-test-key';
process.env.SERPER_API_KEY = 'serper-offline-test-key';
const config = { provider: 'serpapi' };
const json = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const organic = (results) => json({ search_metadata: { status: 'Success' }, organic_results: results });

test('SerpApi encodes Google queries, maps evidence, deduplicates and caches with site filters', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://serpapi.com');
    assert.equal(url.pathname, '/search.json');
    assert.equal(url.searchParams.get('api_key'), process.env.SERPAPI_API_KEY);
    assert.equal(url.searchParams.get('engine'), 'google');
    assert.equal(url.searchParams.get('q'), 'site:linkedin.com/in "Acme" & directors');
    assert.equal(options.redirect, 'error');
    calls++;
    return organic([
      { link: 'https://linkedin.com/in/asha-rao?tracking=1', title: 'Asha Rao', snippet: 'Acme Director' },
      { link: 'https://linkedin.com/in/asha-rao', title: 'Asha Rao - Director - Acme', snippet: 'Acme Director' },
      { link: 'https://linkedin.com/in/bimal-shah', title: 'Bimal Shah', snippet: 'Acme Director' },
      { link: 'https://example.test/team', title: 'Other source' }, null, { link: 'javascript:alert(1)' },
    ]);
  });
  await withSearchConfig(config, async () => {
    const query = 'site:linkedin.com/in "Acme" & directors';
    assert.deepEqual(await searchWeb(query, { limit: 1 }), [{
      url: 'https://linkedin.com/in/asha-rao', title: 'Asha Rao - Director - Acme', snippet: 'Acme Director',
    }]);
    assert.equal((await searchWeb(query, { limit: 10 })).length, 2);
    assert.equal(searchProviderLabel(), 'SerpApi (Google API)');
  });
  assert.equal(calls, 1);
  assert.deepEqual(serpapiStatus(), { configured: true });
});

test('three concurrent provider contexts and caches remain isolated', async (t) => {
  const hosts = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const host = new URL(input).hostname;
    hosts.push(host);
    await new Promise((resolve) => setImmediate(resolve));
    if (host === 'serpapi.com') return organic([{ link: 'https://serpapi-result.test', title: 'Director' }]);
    if (host === 'google.serper.dev') return json({ organic: [{ link: 'https://serper-result.test', title: 'Director' }] });
    assert.equal(host, 'localhost');
    return json({ results: [{ url: 'https://searxng-result.test', title: 'Director' }] });
  });
  const results = await Promise.all(['serpapi', 'serper', 'searxng'].map((provider) =>
    withSearchConfig({ provider, searxngUrl: 'http://localhost:8080' }, async () => {
      const first = await searchWeb('three provider isolation');
      assert.deepEqual(await searchWeb('three provider isolation'), first);
      assert.equal(currentSearchConfig().provider, provider);
      return first[0].url;
    })));
  assert.equal(new Set(results).size, 3);
  assert.equal(hosts.length, 3);
});

test('missing keys and cross-provider probes do not make network requests', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected network call'));
  assert.equal((await withSearchConfig(config, verifySerperKey)).skipped, true);
  await withSearchConfig({ provider: 'serper' }, () => assert.rejects(runSerpapi('probe'), /disabled/));
  const key = process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEY = '';
  t.after(() => { process.env.SERPAPI_API_KEY = key; });
  const check = await withSearchConfig(config, verifySearchProvider);
  assert.equal(check.configured, false);
  assert.equal(check.ok, false);
  assert.match(check.error, /SERPAPI_API_KEY not set/);
});

test('empty Google searches remain empty and do not trigger fallback services', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(new URL(input).hostname, 'serpapi.com');
    calls++;
    return calls % 2 ? json({ search_metadata: { status: 'Success' },
      search_information: { organic_results_state: 'Fully empty' },
      error: "Google hasn't returned any results for this query.",
    }) : organic([]);
  });
  await withSearchConfig(config, async () => {
    assert.deepEqual(await searchWithFallbackQueries(() => ['empty serpapi 1', 'empty serpapi 2']), []);
    const check = await verifySearchProvider();
    assert.equal(check.ok, false);
    assert.match(check.error, /no search results/);
  });
  assert.equal(calls, 3);
});

test('auth, quota, malformed responses and network failures are explicit and never expose the key', async (t) => {
  let respond;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(new URL(input).hostname, 'serpapi.com');
    calls++;
    return respond();
  });
  const cases = [
    [() => new Response('', { status: 401 }), /key rejected/],
    [() => new Response('', { status: 403 }), /key rejected/],
    [() => new Response('', { status: 429 }), /quota exhausted or rate limited/],
    [() => new Response('', { status: 503 }), /HTTP 503/],
    [() => json({ error: `Invalid API key ${process.env.SERPAPI_API_KEY}` }), /key rejected/],
    [() => json({ error: 'Your account has run out of searches.' }), /quota/],
    [() => json({ search_metadata: { status: 'Error' }, error: 'Internal error' }), /could not complete/],
    [() => json({ search_metadata: { status: 'Processing' } }), /could not complete/],
    [() => new Response('<html>bad gateway</html>'), /valid JSON/],
    [() => json({}), /missing search results/],
    [() => json({ organic_results: {} }), /must be an array/],
    [() => { throw new Error(`fetch https://serpapi.com/search.json?api_key=${process.env.SERPAPI_API_KEY}`); }, /Cannot reach/],
  ];
  for (const [i, [response, pattern]] of cases.entries()) {
    respond = response;
    await withSearchConfig(config, () => assert.rejects(searchWeb(`serpapi failure ${i}`), (err) => {
      assert.equal(err.code, 'SEARCH_UNAVAILABLE');
      assert.match(err.message, pattern);
      assert.equal(err.message.includes(process.env.SERPAPI_API_KEY), false);
      return true;
    }));
  }
  assert.equal(calls, cases.length);
});

test('SerpApi timeout covers body consumption', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (input, { signal }) => ({
    ok: true, json: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
  }));
  const result = withSearchConfig(config, () => runSerpapi('slow response'));
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await assert.rejects(result, /timed out after 30 seconds/);
});

test('SerpApi registry snippets produce directors whose LinkedIn matches require employer evidence', async (t) => {
  const queries = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'serpapi.com');
    const query = url.searchParams.get('q');
    queries.push(query);
    if (query.includes('site:zaubacorp.com')) return organic([{
      link: 'https://www.zaubacorp.com/ACME-FOODS-PRIVATE-LIMITED-U12345AA2000PTC123456',
      title: 'ACME FOODS PRIVATE LIMITED', snippet: 'Directors of ACME FOODS PRIVATE LIMITED are ASHA RAO and BIMAL SHAH.',
    }]);
    if (query.includes('ASHA RAO')) return organic([
      { link: 'https://linkedin.com/in/asha-rao-wrong', title: 'Asha Rao - Director - Unrelated Business' },
      { link: 'https://linkedin.com/in/asha-rao-acme', title: 'Asha Rao - Managing Director', snippet: 'Experience: Acme Foods Private Limited' },
    ]);
    return organic([{ link: 'https://linkedin.com/in/bimal-shah-wrong', title: 'Bimal Shah - Director - Unrelated Business' }]);
  });
  await withSearchConfig(config, async () => {
    const results = await searchWeb('site:zaubacorp.com "Acme Foods Private Limited"');
    const directors = parseDirectorsFromSearchResults(results, 'Acme Foods Private Limited');
    assert.deepEqual(directors.map((d) => d.name), ['ASHA RAO', 'BIMAL SHAH']);
    const verdict = await verifyDirectorOnLinkedIn(directors[0].name, 'Acme Foods Private Limited', 'Director');
    assert.equal(verdict.url, 'https://linkedin.com/in/asha-rao-acme');
    const missing = await verifyDirectorOnLinkedIn(directors[1].name, 'Acme Foods Private Limited', 'Director');
    assert.equal(missing.url, null);
  });
  assert.ok(queries.some((q) => q.startsWith('ASHA RAO Acme Foods Private Limited')));
  assert.ok(queries.some((q) => q.startsWith('site:linkedin.com/in')));
});

test('SerpApi jobs record their provider and fail before processing on connection errors', async (t) => {
  let failed = false;
  t.mock.method(globalThis, 'fetch', async () => failed ? new Response('', { status: 401 }) : organic([{ link: 'https://linkedin.com', title: 'LinkedIn' }]));
  const meta = {};
  const job = { log() {}, setMeta(value) { Object.assign(meta, value); } };
  assert.deepEqual(await runAgent([], job, config), []);
  assert.equal(meta.searchProvider, 'SerpApi (Google API)');
  failed = true;
  await assert.rejects(runAgent(['Acme Foods'], job, config), /SerpApi connection failed:.*key rejected/);
});
