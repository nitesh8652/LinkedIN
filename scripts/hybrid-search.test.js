const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withSearchConfig, searchProviderLabel } = require('../src/search-config');
const { searchWeb, searchWithFallbackQueries, verifySearchProvider } = require('../src/search');
const { verifyDirectorOnLinkedIn, matchCompanyName } = require('../src/zaubacorp');
const { companySearchName, brandTokens } = require('../src/normalize');
process.env.SERPAPI_API_KEY = 'hybrid-offline-key';
const profile = { url: 'https://in.linkedin.com/in/vinay-rathi-84940137', title: 'Vinay Rathi - Gloster Cables Ltd', snippet: 'Director at Gloster Cables Limited' };
const respond = (host, rows) => new Response(JSON.stringify(host === 'serpapi.com'
  ? { organic_results: rows.map((r) => ({ link: r.url, title: r.title, snippet: r.snippet })) }
  : { results: rows.map((r) => ({ ...r, content: r.snippet, engines: ['google'] })) }));
const config = (id) => ({ provider: 'hybrid', searxngUrl: `http://hybrid-${id}.test` });

for (const winner of ['serpapi.com', 'hybrid-fast.test']) {
  test(`parallel searches return ${winner}'s useful result without waiting for the slow provider`, async (t) => {
    const calls = [], cancelled = [];
    t.mock.method(globalThis, 'fetch', async (input, { signal }) => {
      const host = new URL(input).hostname;
      calls.push(host);
      if (host === winner) return respond(host, [profile]);
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        cancelled.push(host); reject(new DOMException('Cancelled', 'AbortError'));
      }));
    });
    await withSearchConfig(config('fast'), async () => {
      const rows = await searchWeb(`VINAY RATHI GLOSTER CABLES ${winner}`, { accept: (r) => r.url === profile.url });
      assert.equal(rows[0].url, profile.url);
      assert.equal(searchProviderLabel(), 'SerpApi + SearXNG (parallel)');
    });
    assert.equal(calls.length, 2);
    assert.equal(cancelled.length, 1);
  });
}

for (const fastResult of ['empty', 'wrong employer']) {
  test(`a fast ${fastResult} result cannot suppress a slower verified profile`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (input) => {
      const host = new URL(input).hostname;
      if (host === 'serpapi.com') {
        await new Promise((resolve) => setImmediate(resolve));
        return respond(host, [profile]);
      }
      return respond(host, fastResult === 'empty' ? [] : [{ ...profile, url: 'https://linkedin.com/in/vinay-wrong', title: 'Vinay Rathi - Other Business', snippet: '' }]);
    });
    const result = await withSearchConfig(config(fastResult.replace(' ', '-')), () =>
      verifyDirectorOnLinkedIn('VINAY RATHI', 'GLOSTER CABLES LIMITED RXIL', 'Director'));
    assert.equal(result.url, profile.url);
  });
}

test('one failed backend continues with the working one, including valid empty results', async (t) => {
  let empty = false;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const host = new URL(input).hostname;
    if (host !== 'serpapi.com') throw new Error('fetch failed');
    await new Promise((resolve) => setImmediate(resolve));
    return respond(host, empty ? [] : [profile]);
  });
  await withSearchConfig(config('offline'), async () => {
    const check = await verifySearchProvider();
    assert.equal(check.ok, true);
    assert.ok(check.warnings.some((w) => /SearXNG.*Cannot reach/.test(w)));
    empty = true;
    assert.deepEqual(await searchWeb('no results hybrid working provider'), []);
  });
});

test('both failed backends report both reasons without attempting other paid services', async (t) => {
  const hosts = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const host = new URL(input).hostname;
    hosts.push(host);
    return new Response('', { status: host === 'serpapi.com' ? 429 : 503 });
  });
  await withSearchConfig(config('both-failed'), () => assert.rejects(
    searchWithFallbackQueries(() => ['both unavailable', 'do not repeat outages']), (err) => {
      assert.equal(err.code, 'SEARCH_UNAVAILABLE');
      assert.match(err.message, /SerpApi.*quota/);
      assert.match(err.message, /SearXNG.*503/);
      assert.equal(err.message.includes(process.env.SERPAPI_API_KEY), false);
      return true;
    }));
  assert.equal(hosts.length, 2);
});

test('combined cache includes the SearXNG instance and bypasses previously unhelpful evidence', async (t) => {
  let requests = 0;
  let matching = false;
  t.mock.method(globalThis, 'fetch', async (input) => {
    requests++;
    return respond(new URL(input).hostname, matching ? [profile] : [{ ...profile, url: 'https://example.test/info' }]);
  });
  await withSearchConfig(config('cache-a'), async () => {
    await searchWeb('hybrid cache identity');
    matching = true;
    const rows = await searchWeb('hybrid cache identity', { accept: (r) => r.url === profile.url });
    assert.ok(rows.some((r) => r.url === profile.url));
  });
  const before = requests;
  await withSearchConfig(config('cache-b'), () => searchWeb('hybrid cache identity'));
  assert.ok(requests > before);
});

test('RXIL input labels preserve the exact first search and use the matched registry employer', async (t) => {
  assert.equal(companySearchName('MODI GLOSTER CABLES LIMITED RXIL'), 'MODI GLOSTER CABLES LIMITED');
  assert.deepEqual(brandTokens('GLOSTER CABLES LIMITED RXIL'), ['gloster', 'cables']);
  assert.equal(companySearchName('RXIL LIMITED'), 'RXIL LIMITED');
  assert.equal(matchCompanyName('MODI GLOSTER CABLES LIMITED RXIL', 'GLOSTER CABLES LIMITED').accepted, true);
  assert.equal(matchCompanyName('MODI GLOSTER CABLES LIMITED RXIL', 'MODI REALTY LIMITED').accepted, false);
  const queries = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input); queries.push(url.searchParams.get('q'));
    return respond(url.hostname, [profile]);
  });
  const verdict = await withSearchConfig(config('rxil'), () => verifyDirectorOnLinkedIn(
    'VINAY RATHI', 'MODI GLOSTER CABLES LIMITED RXIL', 'Director', () => {}, { matchedCompanyName: 'GLOSTER CABLES LIMITED' }));
  assert.equal(verdict.url, profile.url);
  assert.ok(queries.every((q) => q === 'VINAY RATHI MODI GLOSTER CABLES LIMITED RXIL'));
});
