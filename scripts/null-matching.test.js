const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withSearchConfig } = require('../src/search-config');
const { findLinkedInProfile, validateLinkedInCandidate } = require('../src/linkedin');
const { parseCompanyUrl } = require('../src/zaubacorp');

test('legacy ZaubaCorp search URLs identify the same company as the current URL', () => {
  const canonical = 'https://www.zaubacorp.com/ACME-FOODS-PRIVATE-LIMITED-U12345AA2000PTC123456';
  const expected = parseCompanyUrl(canonical);
  for (const url of [
    'https://www.zaubacorp.com/company/ACME-FOODS-PRIVATE-LIMITED/U12345AA2000PTC123456',
    'https://zaubacorp.com/company/ACME-FOODS-PRIVATE-LIMITED/U12345AA2000PTC123456/?source=google#director-information',
  ]) {
    assert.deepEqual(parseCompanyUrl(url), expected);
  }
  assert.equal(parseCompanyUrl(canonical.toLowerCase()).url, canonical);
  assert.equal(parseCompanyUrl('https://www.zaubacorp.com/company/acme-foods-private-limited/u12345aa2000ptc123456').url, canonical);
});

test('legacy ZaubaCorp LLP URLs retain their registry ID', () => {
  assert.deepEqual(
    parseCompanyUrl('https://www.zaubacorp.com/company/ACME-FOODS-LLP/AAK-7453'),
    parseCompanyUrl('https://www.zaubacorp.com/ACME-FOODS-LLP-AAK-7453')
  );
  assert.equal(parseCompanyUrl('https://www.zaubacorp.com/company/ACME-FOODS-LLP/AAK-7453').cin, 'AAK-7453');
});

test('ZaubaCorp company URL parsing rejects director pages, unrelated hosts and malformed encodings', () => {
  for (const url of [
    'https://www.zaubacorp.com/director/ASHA-RAO/00001234',
    'https://www.zaubacorp.com/company/ASHA-RAO/00001234',
    'https://www.zaubacorp.com/company/ACME-FOODS/NOT-A-CIN',
    'https://zaubacorp.com.example.test/company/ACME-FOODS/U12345AA2000PTC123456',
    'https://www.zaubacorp.com/company/ACME-%ZZ/U12345AA2000PTC123456',
  ]) assert.equal(parseCompanyUrl(url), null, url);
});

test('website director lookup uses SearXNG snippet employer evidence for a custom LinkedIn slug', async (t) => {
  const expectedUrl = 'https://in.linkedin.com/in/arnav-j-fixture';
  const title = 'Arnav Jain - Director | LinkedIn';
  const snippet = 'Experience: Plasmagen Biosciences.';
  assert.equal(validateLinkedInCandidate(expectedUrl, title, 'Arnav Jain', 'Plasmagen Biosciences'), 0);
  assert.ok(validateLinkedInCandidate(expectedUrl, title, 'Arnav Jain', 'Plasmagen Biosciences', snippet) >= 10);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    assert.equal(url.origin, 'http://localhost:8080', 'director lookup must remain on SearXNG');
    return new Response(JSON.stringify({ results: [{ url: expectedUrl, title, content: snippet }] }));
  });
  const url = await withSearchConfig({ provider: 'searxng', searxngUrl: 'http://localhost:8080' }, () =>
    findLinkedInProfile('Arnav Jain', 'Plasmagen Biosciences', 'Director'));
  assert.equal(url, expectedUrl);
  assert.equal(requests.length, 1, 'stop at the first profile proved by its title and snippet');
});
