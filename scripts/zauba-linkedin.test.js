const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withSearchConfig } = require('../src/search-config');
const { verifyDirectorOnLinkedIn } = require('../src/zaubacorp');

const config = { provider: 'searxng', searxngUrl: 'http://localhost:8080' };
const profile = {
  url: 'https://in.linkedin.com/in/rajess-42',
  title: 'Rajesh Sharma - Director | LinkedIn',
  content: 'Experience: Acme Foods Private Limited.',
};

function mockSearch(t, respond) {
  const queries = [];
  const origins = [];
  const engines = [];
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) =>
    nativeTimeout(callback, ms < 2000 ? 0 : ms, ...args));
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    origins.push(url.origin);
    engines.push(url.searchParams.get('engines'));
    const q = url.searchParams.get('q');
    queries.push(q);
    return new Response(JSON.stringify({ results: respond(q, queries.length) }));
  });
  t.after(() => assert.ok(origins.every((origin) => origin === 'http://localhost:8080'), 'SearXNG lookup must never call Serper'));
  // Google leads the list; Bing is the standby for when Google CAPTCHAs a
  // self-hosted instance, which otherwise turns every director into "not found".
  t.after(() => assert.ok(engines.every((engine) => engine === 'google,bing'), 'registry names must be searched on Google through SearXNG, with Bing as standby'));
  return queries;
}

test('registry middle names can resolve to a shorter LinkedIn name with employer in snippet', async (t) => {
  const queries = mockSearch(t, (q) => q.includes('Rajesh Sharma') ? [profile] : []);
  const verdict = await withSearchConfig(config, () =>
    verifyDirectorOnLinkedIn('Rajesh Kumar Sharma', 'Acme Foods Private Limited', 'Director'));
  assert.equal(verdict.url, profile.url);
  assert.equal(verdict.confidence, 'medium');
  assert.equal(queries.length, 2, 'stop as soon as a verified match is found');
  assert.equal(queries[0], 'Acme Foods Private Limited Rajesh Kumar Sharma');
});

test('company plus registry name finds a personal URL among ordinary Google results through SearXNG', async (t) => {
  // Synthetic search fixture for the user's example, not a claimed live profile.
  const expectedUrl = 'https://in.linkedin.com/in/arnav-jain-fixture';
  const queries = mockSearch(t, () => [
    { url: 'https://example.test/plasmagen', title: 'Plasmagen Biosciences company information' },
    { url: 'https://linkedin.com/company/plasmagen-fixture', title: 'Plasmagen Biosciences | LinkedIn' },
    { url: expectedUrl, title: 'Arnav Jain - Plasmagen Biosciences | LinkedIn', content: 'Director at Plasmagen Biosciences' },
  ]);
  const verdict = await withSearchConfig(config, () =>
    verifyDirectorOnLinkedIn('Arnav Jain', 'Plasmagen Biosciences', 'Director'));
  assert.deepEqual(queries, ['Plasmagen Biosciences Arnav Jain']);
  assert.equal(verdict.url, expectedUrl);
  assert.equal(verdict.confidence, 'high');
});

test('a later query can enrich the same profile URL with missing employer evidence', async (t) => {
  const queries = mockSearch(t, (q, call) => [{
    ...profile, url: 'https://in.linkedin.com/in/rsh-422', content: call === 1 ? '' : 'Experience: Acme Snacks.',
  }]);
  const verdict = await withSearchConfig(config, () =>
    verifyDirectorOnLinkedIn('Rajesh Kumar Sharma', 'Acme Snacks Limited', 'Director'));
  assert.equal(verdict.url, 'https://in.linkedin.com/in/rsh-422');
  assert.equal(queries.length, 2);
});

test('name-only fallback still requires company evidence', async (t) => {
  const queries = mockSearch(t, (q) => q === 'site:linkedin.com/in "Rajesh Sharma"' ? [{
    ...profile, url: 'https://in.linkedin.com/in/rajesh-sharma-fallback', content: 'Experience: Fable Foods.',
  }] : []);
  const verdict = await withSearchConfig(config, () =>
    verifyDirectorOnLinkedIn('Rajesh Kumar Sharma', 'Fable Foods Limited', 'Director'));
  assert.equal(verdict.url, 'https://in.linkedin.com/in/rajesh-sharma-fallback');
  assert.equal(queries.at(-1), 'site:linkedin.com/in "Rajesh Sharma"');
});

test('same name at an unrelated company remains unverified', async (t) => {
  mockSearch(t, () => [{
    url: 'https://in.linkedin.com/in/rajesh-sharma-unrelated',
    title: 'Rajesh Sharma - Director - Elsewhere', content: 'Experience: Elsewhere.',
  }]);
  const verdict = await withSearchConfig(config, () =>
    verifyDirectorOnLinkedIn('Rajesh Kumar Sharma', 'Distinctbrand Limited', 'Director'));
  assert.equal(verdict.url, null);
});

test('the requested name in another person\'s snippet does not establish identity', async (t) => {
  mockSearch(t, () => [{
    url: 'https://in.linkedin.com/in/asha-rao-colleague', title: 'Asha Rao - Director',
    content: 'Worked with Rajesh Sharma at Anotherbrand Foods.',
  }]);
  const verdict = await withSearchConfig(config, () =>
    verifyDirectorOnLinkedIn('Rajesh Kumar Sharma', 'Anotherbrand Foods', 'Director'));
  assert.equal(verdict.url, null);
});
