const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSearchConfig, withSearchConfig, currentSearchConfig, searchProviderLabel } = require('../src/search-config');
const { searchWeb, runSearxng, verifySearchProvider, verifySerperKey } = require('../src/search');
const { runAgent } = require('../src/agent');

process.env.SERPER_API_KEY = 'test-key-never-sent-to-network';
const sx = { provider: 'searxng', searxngUrl: 'http://localhost:8080' };
const json = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('direct Serper probes are skipped inside a SearXNG job even with a configured key', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No network call expected'); });
  const check = await withSearchConfig(sx, verifySerperKey);
  assert.equal(check.skipped, true);
  assert.equal(check.ok, false);
  assert.equal(calls, 0);
});

test('validates providers and instance URLs, preserving deployment prefixes', () => {
  assert.equal(resolveSearchConfig({ ...sx, searxngUrl: 'https://example.test/prefix/search/?q=old#top' }).searxngUrl, 'https://example.test/prefix/search');
  assert.equal(resolveSearchConfig({ ...sx, searxngUrl: 'http://localhost:8080/' }).searxngUrl, 'http://localhost:8080/search');
  for (const provider of ['invalid', '', ['serper']]) assert.throws(() => resolveSearchConfig({ provider }));
  for (const searxngUrl of ['', 'invalid', 'file:///etc/passwd', 'https://user:password@example.test']) {
    assert.throws(() => resolveSearchConfig({ ...sx, searxngUrl }));
  }
});

test('SearXNG maps JSON results, deduplicates, applies site filters and limits, without Serper calls', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'http://localhost:8080');
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('q'), 'site:linkedin.com/in "Acme" & founders');
    assert.equal(options.headers['X-API-KEY'], undefined);
    calls++;
    return json({ results: [
      { url: 'https://linkedin.com/in/asha', title: 'Asha Rao', content: 'Acme CEO' },
      { url: 'https://linkedin.com/in/asha?tracking=1', title: 'duplicate' },
      { url: 'https://example.test/team', title: 'Other site' },
      { url: 'javascript:alert(1)', title: 'Unsafe' },
      null,
      { url: 'https://linkedin.com/in/bimal', title: 'Bimal Shah', content: 'Acme founder' },
    ] });
  });
  await withSearchConfig(sx, async () => {
    const query = 'site:linkedin.com/in "Acme" & founders';
    assert.deepEqual(await searchWeb(query, { limit: 1 }), [{ url: 'https://linkedin.com/in/asha', title: 'Asha Rao', snippet: 'Acme CEO' }]);
    assert.equal((await searchWeb(query, { limit: 5 })).length, 2);
  });
  assert.equal(calls, 1);
});

test('cache is separated by provider and SearXNG instance; concurrent contexts stay isolated', async (t) => {
  const origins = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    origins.push(url.origin);
    await new Promise((resolve) => setImmediate(resolve));
    if (url.hostname === 'google.serper.dev') {
      return json({ organic: [{ link: 'https://serper-result.test', title: 'Serper result' }] });
    }
    return json({ results: [{ url: `https://${url.hostname}/result`, title: 'SearXNG result' }] });
  });
  const configs = [{ provider: 'serper' }, { ...sx, searxngUrl: 'https://instance-a.test' }, { ...sx, searxngUrl: 'https://instance-b.test' }];
  const results = await Promise.all(configs.map((config) => withSearchConfig(config, async () => {
    const result = await searchWeb('same query for all providers');
    assert.equal(currentSearchConfig().provider, config.provider);
    return result;
  })));
  assert.equal(origins.length, 3);
  assert.equal(new Set(results.map((r) => r[0].url)).size, 3);
});

test('successful empty SearXNG responses do not fall back to paid or scraped engines', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(new URL(input).hostname, 'localhost');
    calls++;
    return json({ results: [] });
  });
  await withSearchConfig(sx, async () => assert.deepEqual(await searchWeb('no matches test'), []));
  assert.equal(calls, 1);
});

test('explicit Google requests are routed through SearXNG and cached separately from default engines', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    return json({ results: [{
      url: url.searchParams.has('engines') ? 'https://google-result.test/profile' : 'https://default-result.test/profile',
      title: 'Director profile',
    }] });
  });
  await withSearchConfig(sx, async () => {
    const query = 'company director engine isolation';
    assert.equal((await searchWeb(query))[0].url, 'https://default-result.test/profile');
    assert.equal((await searchWeb(query, { searxngEngines: 'google' }))[0].url, 'https://google-result.test/profile');
    await searchWeb(query, { searxngEngines: 'google' });
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.origin === 'http://localhost:8080'));
  assert.equal(requests[1].searchParams.get('engines'), 'google');
  assert.equal(requests[1].searchParams.has('categories'), false, 'categories would add other engines to the Google search');
});

test('Google-through-SearXNG failure cannot switch to Serper or direct scrapers', async (t) => {
  const origins = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    origins.push(new URL(input).origin);
    return new Response('', { status: 503 });
  });
  await withSearchConfig(sx, async () => {
    await assert.rejects(searchWeb('Google provider failure test', { searxngEngines: 'google' }), /SearXNG HTTP 503/);
  });
  assert.deepEqual(origins, ['http://localhost:8080']);
});

test('connection check reports access, rate limit, invalid JSON and upstream failures', async (t) => {
  const cases = [
    [() => new Response('Forbidden', { status: 403 }), /enable json/],
    [() => new Response('Rate limited', { status: 429 }), /rate limited/],
    [() => new Response('Unavailable', { status: 503 }), /HTTP 503/],
    [() => new Response('<html>challenge</html>'), /did not return JSON/],
    [() => json({}), /missing results array/],
    [() => json({ results: [], unresponsive_engines: [['google', 'timeout']] }), /upstream engines/],
    [() => json({ results: [], unresponsive_engines: [['google', 'Suspended: CAPTCHA']] }), /google: Suspended: CAPTCHA/],
    [() => { throw new TypeError('fetch failed'); }, /Cannot reach/],
  ];
  let respond;
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(new URL(input).hostname, 'localhost');
    return respond();
  });
  for (const [response, error] of cases) {
    respond = response;
    const check = await withSearchConfig(sx, verifySearchProvider);
    assert.equal(check.ok, false);
    assert.match(check.error, error);
  }
});

test('SearXNG timeout includes response body consumption', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (input, { signal }) => ({
    ok: true,
    json: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
  }));
  const result = withSearchConfig(sx, runSearxng.bind(null, 'timeout'));
  await Promise.resolve();
  t.mock.timers.tick(20000);
  await assert.rejects(result, /timed out/);
});

test('SearXNG runtime failure falls back to scraped search, never Serper', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === 'localhost') return new Response('', { status: 503 });
    assert.equal(url.hostname, 'html.duckduckgo.com');
    return new Response('<a href="https://acme.test/team">Acme founders</a>');
  });
  await withSearchConfig(sx, async () => {
    assert.equal((await searchWeb('Acme runtime fallback'))[0].url, 'https://acme.test/team');
    assert.equal(searchProviderLabel(), 'SearXNG + scraped fallback engines');
  });
  await withSearchConfig(sx, async () => {
    await searchWeb('Acme runtime fallback');
    assert.equal(searchProviderLabel(), 'SearXNG + scraped fallback engines', 'cached fallback results retain their source');
  });
  assert.deepEqual(calls, ['localhost', 'html.duckduckgo.com']);
});

test('agent checks selected SearXNG provider, records it, and fails early for setup errors', async (t) => {
  let failed = false;
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(new URL(input).hostname, 'localhost');
    return failed ? new Response('', { status: 403 }) : json({ results: [] });
  });
  const meta = {};
  const job = { log() {}, setMeta(value) { Object.assign(meta, value); } };
  assert.deepEqual(await runAgent([], job, sx), []);
  assert.equal(meta.searchProvider, 'SearXNG');
  failed = true;
  await assert.rejects(runAgent(['Acme'], job, sx), /SearXNG connection failed/);
});
