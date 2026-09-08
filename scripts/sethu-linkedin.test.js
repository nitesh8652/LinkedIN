const { test } = require('node:test');
const assert = require('node:assert/strict');

// These tests exercise deterministic matching, never a configured paid LLM.
let llmCalls = 0;
let llmChoice = null;
const llmPath = require.resolve('../src/llm');
require.cache[llmPath] = { id: llmPath, filename: llmPath, loaded: true, exports: {
  pickLinkedInWithLlm: async () => { llmCalls += 1; return llmChoice; },
} };

const { withSearchConfig } = require('../src/search-config');
const { findLinkedInProfile, validateLinkedInCandidate } = require('../src/linkedin');
const { verifyDirectorOnLinkedIn } = require('../src/zaubacorp');

// Observed public search result: the company website abbreviates this profile's
// full name to Sethu Madhavan. Tests use a fixture, with no live network requests.
const company = 'Plasmagen Biosciences';
const name = 'Sethu Madhavan';
const observed = {
  url: 'https://in.linkedin.com/in/sethu-madhavan-sankaran-983b536',
  title: 'Sethu Madhavan Sankaran - PlasmaGen BioSciences (P) Ltd | LinkedIn',
  content: 'Chief Operating Officer at PlasmaGen BioSciences (P) Ltd.',
};

let fixtureNumber = 0;
function useSearchFixture(t, resultsForQuery) {
  const origin = `http://localhost:${19000 + fixtureNumber++}`;
  const queries = [];
  llmCalls = 0;
  llmChoice = null;
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) =>
    nativeTimeout(callback, ms < 2000 ? 0 : ms, ...args));
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, origin, 'SearXNG lookups must remain on the selected instance');
    const query = url.searchParams.get('q');
    queries.push(query);
    return new Response(JSON.stringify({ results: resultsForQuery(query) }));
  });
  return { queries, run: (fn) => withSearchConfig({ provider: 'searxng', searxngUrl: origin }, fn) };
}

test('observed Sethu Madhavan profile matches the shorter name on the official website', () => {
  assert.ok(validateLinkedInCandidate(observed.url, observed.title, name, company, observed.content) >= 10);
});

test('website lookup finds the full LinkedIn name through a plain company plus name query', async (t) => {
  const fixture = useSearchFixture(t, (query) => query === `${company} ${name}` ? [
    { url: 'https://plasmagen.com/lead_desc/Sethu%20Madhavan', title: 'Sethu Madhavan - PlasmaGen' },
    { url: 'https://in.linkedin.com/company/plasmagen-biosciences', title: observed.title },
    { url: 'https://in.linkedin.com/in/unrelated-colleague-fixture', title: 'Another Person - PlasmaGen BioSciences', content: 'Worked with Sethu Madhavan.' },
    observed,
  ] : []);
  const result = await fixture.run(() => findLinkedInProfile(name, company, 'Chief Operating Officer'));
  assert.equal(result, observed.url);
  assert.deepEqual(fixture.queries, [`${company} ${name}`]);
  assert.equal(llmCalls, 0);
});

test('registry verification accepts the same full name with employer evidence', async (t) => {
  const fixture = useSearchFixture(t, () => [observed]);
  const result = await fixture.run(() => verifyDirectorOnLinkedIn(name, company, 'Director'));
  assert.equal(result.url, observed.url);
  assert.equal(result.confidence, 'high');
  assert.equal(fixture.queries.length, 1);
});

test('unquoted LinkedIn site search runs when the quoted spelling produces no profile', async (t) => {
  const unquoted = `site:linkedin.com/in ${name} plasmagen biosciences`;
  const fixture = useSearchFixture(t, (query) => query === unquoted ? [observed] : []);
  assert.equal(await fixture.run(() => findLinkedInProfile(name, company, 'COO')), observed.url);
  assert.equal(fixture.queries.at(-1), unquoted);
  assert.equal(llmCalls, 0);
});

test('a same-name profile at another employer cannot stop the fallback searches', async (t) => {
  const wrong = { ...observed, url: 'https://in.linkedin.com/in/sethu-madhavan-unrelated',
    title: 'Sethu Madhavan - Elsewhere Biosciences | LinkedIn', content: 'COO at Elsewhere Biosciences.' };
  const fixture = useSearchFixture(t, (query) => query === `${company} ${name}` ? [wrong] : [observed]);
  assert.equal(await fixture.run(() => findLinkedInProfile(name, company, 'COO')), observed.url);
  assert.equal(fixture.queries.length, 2);
});

test('same-name results without the requested company remain null after all queries', async (t) => {
  const fixture = useSearchFixture(t, () => [{ ...observed,
    title: 'Sethu Madhavan Sankaran - Elsewhere Biosciences | LinkedIn', content: 'COO at Elsewhere Biosciences.' }]);
  assert.equal(await fixture.run(() => findLinkedInProfile(name, company, 'COO')), null);
  assert.equal(llmCalls, 0, 'an LLM must not override missing employer evidence');
});

test('company evidence in the search snippet still resolves the profile', async (t) => {
  const fixture = useSearchFixture(t, () => [{ ...observed, title: 'Sethu Madhavan Sankaran | LinkedIn',
    content: 'Experience: PlasmaGenBioSciences.' }]);
  assert.equal(await fixture.run(() => findLinkedInProfile(name, company, 'COO')), observed.url);
});

test('another person mentioning the requested name cannot become the selected profile', async (t) => {
  const wrong = 'https://in.linkedin.com/in/asha-rao-fixture';
  const fixture = useSearchFixture(t, () => [{ url: wrong, title: 'Asha Rao - PlasmaGen BioSciences',
    content: 'Worked with Sethu Madhavan at PlasmaGen BioSciences.' }]);
  llmChoice = wrong;
  assert.equal(await fixture.run(() => findLinkedInProfile(name, company, 'COO')), null);
});

test('an LLM cannot supply a profile absent from employer-backed search evidence', async (t) => {
  const fixture = useSearchFixture(t, () => [{ url: 'https://in.linkedin.com/in/opaque-fixture',
    title: 'Sethu - PlasmaGen BioSciences', content: 'Experience: PlasmaGen BioSciences.' }]);
  llmChoice = observed.url;
  assert.equal(await fixture.run(() => findLinkedInProfile(name, company, 'COO')), null);
  assert.equal(llmCalls, 1);
});
