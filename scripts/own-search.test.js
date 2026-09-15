const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOwnSearch, parseSearchPage, resultUrl, mergeResults } = require('../src/own-search');
const { isRelevant, queryConstraints } = require('../src/search');
const { withSearchConfig } = require('../src/search-config');

const run = (fn, url = 'http://local.test:8080') => withSearchConfig({ provider: 'own', searxngUrl: url }, fn);
const profile = { url: 'https://in.linkedin.com/in/asha-rao', title: 'Asha Rao - Acme Industries | LinkedIn', snippet: 'Director at Acme Industries', sources: ['searxng'] };
const accept = (r) => r.url.includes('/in/asha-rao') && `${r.title} ${r.snippet}`.includes('Acme');
const fail = async () => { throw new Error('offline'); };
const pending = (signal) => new Promise((_, reject) => {
  if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
  else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
});
const fixture = (options = {}) => createOwnSearch({ queryConstraints, isRelevant, intervalMs: 0, fallbackDelayMs: 0, runSearxng: fail, fetchImpl: fail, ...options });
const ddg = (row = profile) => `<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(row.url)}">${row.title}</a></h2><a class="result__snippet">${row.snippet}</a></div>`;

test('HTML parsers retain employer snippets, decode relative redirects and ignore navigation', () => {
  const [row] = parseSearchPage('duckduckgo', `<a href="https://noise.test">Noise</a>${ddg()}`, 'https://html.duckduckgo.com/');
  assert.equal(row.url, profile.url);
  assert.equal(row.snippet, profile.snippet);
  const brave = `<div class="snippet"><a href="${profile.url}"><div class="title">${profile.title}</div></a><div class="generic-snippet">${profile.snippet}</div></div>`;
  assert.equal(parseSearchPage('brave', brave, 'https://search.brave.com')[0].snippet, profile.snippet);
  assert.equal(parseSearchPage('bing', '<rss><channel><item><title>Acme</title><link>https://acme.test/Team?id=5</link><description>CEO Asha Rao</description></item></channel></rss>')[0].url, 'https://acme.test/Team?id=5');
  assert.throws(() => parseSearchPage('google', '<form>CAPTCHA</form>', 'https://google.com'), /CAPTCHA/);
  assert.throws(() => parseSearchPage('brave', '<html>Unknown markup</html>', 'https://search.brave.com'), /no readable/);
  assert.deepEqual(parseSearchPage('duckduckgo', '<div>No results found</div>'), []);
  assert.equal(resultUrl('https://example.com/Team?member=AbC&utm_source=google'), 'https://example.com/Team?member=AbC');
  assert.equal(resultUrl('javascript:alert(1)'), null);
});

test('site constraints enforce host/path boundaries and merged LinkedIn evidence preserves source URLs', () => {
  const constraints = queryConstraints('site:linkedin.com/in Asha Rao');
  for (const url of ['https://linkedin.com.evil.test/in/asha', 'https://evil.test/linkedin.com/in/asha', 'https://linkedin.com/industry/asha']) {
    assert.equal(isRelevant({ url }, constraints, { trusted: true }), false);
  }
  const rows = mergeResults([profile, { ...profile, url: 'https://www.linkedin.com/in/asha-rao/?trk=search', snippet: 'Board director', sources: ['brave'] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, profile.url);
  assert.match(rows[0].snippet, /Acme Industries.*Board director/);
  assert.deepEqual(rows[0].sources, ['searxng', 'brave']);
});

test('fast irrelevant namesake cannot beat the slower verified employer match; losers are aborted', async () => {
  let aborted = 0;
  const engine = fixture({
    runSearxng: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return [profile];
    },
    fetchImpl: async (url, { signal }) => {
      if (url.includes('duckduckgo')) return new Response(ddg({ ...profile, title: 'Asha Rao - Other employer', snippet: 'CEO at Other' }));
      signal.addEventListener('abort', () => { aborted++; });
      return pending(signal);
    },
  });
  const data = await run(() => engine.search('Asha Rao Acme Industries', { accept }));
  assert.equal(data.results.find(accept).url, profile.url);
  assert.equal(aborted, 2);
});

test('direct engine recovers when SearXNG fails, never calls paid endpoints, caches useful evidence', async () => {
  const urls = [];
  const engine = fixture({ fetchImpl: async (url) => {
    urls.push(url);
    if (url.includes('duckduckgo')) return new Response(ddg());
    return new Response('rate limited', { status: 429 });
  } });
  const data = await run(() => engine.search('Asha Rao Acme Industries', { accept }));
  assert.ok(data.results.some(accept));
  assert.ok(data.warnings.some((w) => /searxng/.test(w)));
  assert.ok(urls.every((url) => !/serper|serpapi/.test(url)));
  const count = urls.length;
  const cached = await run(() => engine.search('Asha Rao Acme Industries', { accept }));
  assert.equal(cached.cached, true);
  assert.equal(urls.length, count);
  assert.equal(cached.warnings.length, data.warnings.length);
});

test('valid empty results are not cached; source failures are not reported as no match', async () => {
  let queries = 0;
  const engine = fixture({ runSearxng: async () => { queries++; return []; }, fetchImpl: async () => new Response('No results found') });
  for (let n = 0; n < 2; n++) assert.deepEqual((await run(() => engine.search('Asha Rao'))).results, []);
  assert.equal(queries, 2);
  const degraded = fixture({ runSearxng: async () => [] });
  await assert.rejects(run(() => degraded.search('Asha Rao')), { code: 'SEARCH_UNAVAILABLE', retryWithRemainingEngines: true });
});

test('source cooldown avoids repeated outages and recovers; instance and cache expiry stay isolated', async () => {
  let time = 100000;
  let calls = 0;
  let recovered = false;
  const engine = fixture({ now: () => time, cacheTtlMs: 1000, runSearxng: async () => {
    calls++;
    if (!recovered) throw new Error('offline');
    return [profile];
  } });
  await assert.rejects(run(() => engine.search('Asha Rao')), { code: 'SEARCH_UNAVAILABLE' });
  await assert.rejects(run(() => engine.search('Asha Rao')), { code: 'SEARCH_UNAVAILABLE' });
  assert.equal(calls, 1);
  recovered = true;
  time += 61000;
  assert.ok((await run(() => engine.search('Asha Rao'))).results.length);
  assert.equal((await run(() => engine.search('Asha Rao'))).cached, true);
  time += 1001;
  assert.equal((await run(() => engine.search('Asha Rao'))).cached, false);
  assert.equal((await run(() => engine.search('Asha Rao'), 'http://other.test')).cached, false);
  assert.equal(calls, 4);
});

test('deadline covers response body consumption and aborts stalled sources', async () => {
  let cancelled = 0;
  const engine = fixture({ timeoutMs: 50,
    runSearxng: (_, { signal }) => pending(signal),
    fetchImpl: async (_, { signal }) => new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => { cancelled++; controller.error(new DOMException('Aborted', 'AbortError')); });
    } })),
  });
  await assert.rejects(run(() => engine.search('deadline check')), { code: 'SEARCH_UNAVAILABLE' });
  assert.equal(cancelled, 3);
  assert.ok(run(() => engine.status()).engines.every((e) => e.status === 'cooldown'));
});

test('client cancellation releases capacity and never poisons source health', async () => {
  const engine = fixture({ runSearxng: (_, { signal }) => pending(signal), fetchImpl: (_, { signal }) => pending(signal) });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pendingQueries = controllers.map((c, i) => assert.rejects(run(() => engine.search(`query ${i}`, { signal: c.signal })), { name: 'AbortError' }));
  await assert.rejects(run(() => engine.search('overflow')), /busy/);
  controllers.forEach((c) => c.abort());
  await Promise.all(pendingQueries);
  assert.equal(run(() => engine.status()).activeRequests, 0);
  assert.ok(run(() => engine.status()).engines.every((e) => e.status === 'untested'));
});

test('cached unhelpful evidence is bypassed when a new caller requires a profile', async () => {
  let matching = false;
  const engine = fixture({ runSearxng: async () => [{ ...profile, url: matching ? profile.url : 'https://example.test/acme' }] });
  await run(() => engine.search('Acme Industries'));
  matching = true;
  const data = await run(() => engine.search('Acme Industries', { accept }));
  assert.equal(data.cached, false);
  assert.ok(data.results.some(accept));
});

test('cached accepted profiles remain visible when the caller requests a smaller limit', async () => {
  const engine = fixture({ runSearxng: async () => [{ ...profile, url: 'https://acme.test/about' }, profile] });
  await run(() => engine.search('Acme Industries'));
  const data = await run(() => engine.search('Acme Industries', { accept, limit: 1 }));
  assert.equal(data.cached, true);
  assert.equal(data.results.length, 1);
  assert.ok(accept(data.results[0]));
});

test('partial SearXNG suspensions keep healthy engines eligible for later query variants and companies', async () => {
  let searxCalls = 0;
  const directCalls = [];
  const engine = fixture({
    runSearxng: async () => {
      searxCalls++;
      if (searxCalls === 1) throw Object.assign(new Error('SearXNG upstream engines unavailable (duckduckgo: CAPTCHA; brave: too many requests)'), {
        code: 'SEARCH_UNAVAILABLE', retryWithRemainingEngines: true,
      });
      return [profile];
    },
    fetchImpl: async (url) => {
      directCalls.push(url);
      return new Response('blocked', { status: url.includes('duckduckgo') ? 202 : 429 });
    },
  });
  await assert.rejects(run(() => engine.search('narrow query')), { code: 'SEARCH_UNAVAILABLE', retryWithRemainingEngines: true });
  const health = run(() => engine.status()).engines;
  assert.notEqual(health.find((s) => s.name === 'searxng').status, 'cooldown');
  assert.ok(health.filter((s) => s.name !== 'searxng').every((s) => s.status === 'cooldown'));
  const before = directCalls.length;
  const recovered = await run(() => engine.search('Asha Rao Acme Industries', { accept }));
  assert.ok(recovered.results.some(accept));
  assert.equal(searxCalls, 2);
  assert.equal(directCalls.length, before, 'real CAPTCHA/rate-limit blocks still stay on cooldown');
});

test('unrelated Bing results reject this query without disabling a later relevant query', async () => {
  let calls = 0;
  const engine = fixture({ fetchImpl: async (url) => {
    if (!url.includes('bing.com')) return new Response('blocked', { status: 429 });
    calls++;
    const row = calls === 1 ? { url: 'https://unrelated.test/', title: 'Anime codes', snippet: 'Gaming' } : profile;
    return new Response(`<rss><channel><item><link>${row.url}</link><title>${row.title}</title><description>${row.snippet}</description></item></channel></rss>`);
  } });
  await assert.rejects(run(() => engine.search('Asha Rao Acme Industries')), { code: 'SEARCH_UNAVAILABLE', retryWithRemainingEngines: true });
  assert.notEqual(run(() => engine.status()).engines.find((s) => s.name === 'bing').status, 'cooldown');
  assert.ok((await run(() => engine.search('Asha Rao Acme Industries profile', { accept }))).results.some(accept));
  assert.equal(calls, 2);
});

test('healthy SearXNG head start avoids duplicate direct requests; failed SearXNG releases fallbacks promptly', async () => {
  let calls = 0;
  const healthy = fixture({ fallbackDelayMs: 5000, runSearxng: async () => [profile], fetchImpl: async () => { calls++; throw new Error('must not run'); } });
  assert.ok((await run(() => healthy.search('Asha Rao Acme Industries', { accept }))).results.some(accept));
  assert.equal(calls, 0);
  const failed = fixture({ fallbackDelayMs: 5000, timeoutMs: 500, fetchImpl: async (url) => {
    calls++;
    return url.includes('duckduckgo') ? new Response(ddg()) : new Response('blocked', { status: 429 });
  } });
  assert.ok((await run(() => failed.search('Asha Rao Acme Industries', { accept }))).results.some(accept));
  assert.ok(calls > 0, 'failures release direct fallbacks before the 5-second delay or deadline');
});

test('Own Search query fallback retries Google through SearXNG while CAPTCHA engines remain suspended', async (t) => {
  const { runSearxng, ownSearch, searchWithFallbackQueries } = require('../src/search');
  const requests = [];
  const company = { url: 'https://www.zaubacorp.com/GLOSTER-CABLES-LIMITED-U31300TG1995PLC019694', title: 'GLOSTER CABLES LIMITED | ZaubaCorp', content: 'Company directors', engines: ['google'] };
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.hostname === 'own-partial.test') {
      requests.push({ query: url.searchParams.get('q'), engines: url.searchParams.get('engines') });
      return new Response(JSON.stringify(requests.length === 1
        ? { results: [], unresponsive_engines: [['duckduckgo', 'CAPTCHA'], ['brave', 'too many requests']] }
        : { results: [company], unresponsive_engines: [] }));
    }
    assert.ok(['html.duckduckgo.com', 'search.brave.com', 'www.bing.com'].includes(url.hostname), 'No paid or unconfigured search request');
    return new Response('blocked', { status: url.hostname.includes('duckduckgo') ? 202 : 429 });
  });
  const engine = fixture({ runSearxng, fetchImpl: (...args) => fetch(...args) });
  t.mock.method(ownSearch, 'search', (query, options) => engine.search(query, options));
  const rows = await run(() => searchWithFallbackQueries(() => [
    'site:zaubacorp.com "GLOSTER CABLES LIMITED RXIL"', 'site:zaubacorp.com "gloster cables"',
  ], { accept: (r) => r.url.toLowerCase() === company.url.toLowerCase(), minAccepted: 1 }), 'http://own-partial.test');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, company.url.toLowerCase());
  assert.deepEqual(requests.map((r) => r.engines), ['google,bing,duckduckgo,brave', 'google,bing']);
});
