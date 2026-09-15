const { test } = require('node:test');
const assert = require('node:assert/strict');

let scenario = {};
const calls = [];
const sourceUrl = 'https://www.zaubacorp.com/company/EXAMPLE/U12345#director-information';
const profileUrl = 'https://linkedin.com/in/asha-rao-fixture';
const person = (name) => ({ name, designation: 'Director' });
const unavailable = (message, retryWithRemainingEngines = true) => Object.assign(new Error(message), {
  code: 'SEARCH_UNAVAILABLE', retryWithRemainingEngines,
});
function stub(name, exports) {
  const filename = require.resolve(`../src/${name}`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('llm', { llmEnabled: () => false });
stub('search', {
  verifySearchProvider: async () => ({ ok: true }),
  searchWeb: async () => [],
  searchWithFallbackQueries: async () => {
    calls.push('generic search');
    if (scenario.genericError) throw scenario.genericError;
    return [];
  },
  closeSearchBrowser: async () => {},
});
stub('discover', { findOfficialWebsiteWithQueries: async () => scenario.website ? { url: 'https://company.test' } : null });
stub('crawler', { crawlWebsiteForLeaders: async () => ({ leaders: scenario.leaders || [], pagesVisited: ['https://company.test'] }) });
stub('extract', { extractLeaders: () => [] });
stub('linkedin', { findLinkedInProfile: async (name) => {
  calls.push(`website: ${name}`);
  if (scenario.websiteErrors?.[name]) throw scenario.websiteErrors[name];
  return scenario.websiteMatches?.[name] || null;
} });
stub('zaubacorp', {
  ZAUBA_SOURCE: 'ZaubaCorp', WEBSITE_SOURCE: 'Official Website',
  findDirectorsOnZaubaCorp: async () => {
    calls.push('registry');
    return scenario.registryFailure || {
      ok: true, matchedName: 'Example Company', confidence: 'high', pageUrl: sourceUrl,
      directors: scenario.directors || [],
    };
  },
  verifyDirectorOnLinkedIn: async (name) => {
    calls.push(`registry: ${name}`);
    if (scenario.registryErrors?.[name]) throw scenario.registryErrors[name];
    return { url: scenario.registryMatches?.[name] || null, confidence: 'high' };
  },
  closeZaubaBrowser: async () => {},
});
const { runAgent } = require('../src/agent');
async function run(options) {
  scenario = options;
  calls.length = 0;
  return runAgent(['Example Company'], { log() {}, setMeta() {}, setProgress() {}, onRow() {} }, { provider: 'own' });
}

test('a partial registry profile failure retains its reason and continues later people', async () => {
  const rows = await run({
    directors: [person('Bimal Shah'), person('Asha Rao'), person('Chetan Das')],
    registryErrors: { 'Bimal Shah': unavailable('Bimal query has no relevant results while some engines are blocked') },
    registryMatches: { 'Asha Rao': profileUrl },
  });
  assert.deepEqual(rows.map((row) => row.status), ['search_unavailable', 'ok', 'linkedin_unverified']);
  assert.equal(rows[0].reason, 'Bimal query has no relevant results while some engines are blocked');
  assert.equal(rows[1].linkedinUrl, profileUrl);
  assert.equal(rows[1].reason, undefined);
  assert.equal(rows[2].reason, undefined);
  assert.ok(calls.includes('registry: Chetan Das'));
});

test('a partial website profile failure continues later people and permits registry recovery', async () => {
  const rows = await run({
    website: true, leaders: [person('Bimal Shah'), person('Asha Rao'), person('Chetan Das')],
    websiteErrors: { 'Bimal Shah': unavailable('Bimal query temporarily unavailable') },
    websiteMatches: { 'Asha Rao': profileUrl },
    directors: [person('Bimal Shah')], registryMatches: { 'Bimal Shah': 'https://linkedin.com/in/bimal-shah-fixture' },
  });
  assert.deepEqual(rows.map((row) => row.status), ['ok', 'ok', 'no_linkedin']);
  assert.equal(rows[0].reason, undefined);
  assert.equal(rows[1].linkedinUrl, profileUrl);
  assert.ok(calls.includes('website: Chetan Das'));
  assert.ok(calls.includes('registry: Bimal Shah'));
});

test('an unsuccessful registry verification preserves the affected website row outage reason', async () => {
  const rows = await run({
    website: true, leaders: [person('Bimal Shah'), person('Chetan Das')],
    websiteErrors: { 'Bimal Shah': unavailable('Bimal query incomplete') },
    directors: [person('Bimal Shah')],
  });
  assert.equal(rows[0].status, 'search_unavailable');
  assert.equal(rows[0].reason, 'Bimal query incomplete');
  assert.equal(rows[1].status, 'no_linkedin');
  assert.equal(rows[1].reason, undefined);
});

test('a registry director outage does not mark unrelated website directors unavailable', async () => {
  const rows = await run({
    website: true, leaders: [person('Bimal Shah'), person('Chetan Das')],
    directors: [person('Arnav Jain'), person('Asha Rao')],
    registryErrors: { 'Arnav Jain': unavailable('Arnav query incomplete') },
    registryMatches: { 'Asha Rao': profileUrl },
  });
  assert.deepEqual(rows.map((row) => row.status), ['no_linkedin', 'no_linkedin', 'search_unavailable', 'ok']);
  assert.equal(rows[0].reason, undefined);
  assert.equal(rows[2].reason, 'Arnav query incomplete');
});

test('a partial supplemental search failure still verifies an extracted website director', async () => {
  const rows = await run({
    website: true, leaders: [person('Asha Rao')], genericError: unavailable('Generic query incomplete'),
    websiteMatches: { 'Asha Rao': profileUrl },
  });
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].linkedinUrl, profileUrl);
  assert.ok(calls.includes('website: Asha Rao'));
});

test('partial supplemental failures with no website names still allow direct registry recovery', async () => {
  const rows = await run({
    website: true, genericError: unavailable('Generic query incomplete'),
    directors: [person('Asha Rao')], registryMatches: { 'Asha Rao': profileUrl },
  });
  assert.equal(calls.filter((call) => call === 'generic search').length, 2);
  assert.equal(rows[0].linkedinUrl, profileUrl);
});

test('partial supplemental failures remain unavailable when registry recovery also yields nothing', async () => {
  const rows = await run({
    website: true, genericError: unavailable('Generic query incomplete'),
    registryFailure: { ok: false, reason: 'ZaubaCorp page not found' },
  });
  assert.equal(rows[0].status, 'search_unavailable');
  assert.equal(rows[0].reason, 'Generic query incomplete');
});

test('a later hard registry outage stops subsequent requests without replacing earlier row reasons', async () => {
  const rows = await run({
    directors: [person('Bimal Shah'), person('Chetan Das'), person('Asha Rao')],
    registryErrors: {
      'Bimal Shah': unavailable('Bimal query incomplete'),
      'Chetan Das': unavailable('All engines offline', false),
    },
  });
  assert.deepEqual(rows.map((row) => row.reason), ['Bimal query incomplete', 'All engines offline', 'All engines offline']);
  assert.equal(calls.includes('registry: Asha Rao'), false);
});

test('a matched registry page remains available on an unavailable director-information row', async () => {
  const rows = await run({ registryFailure: {
    ok: false, errorCode: 'SEARCH_UNAVAILABLE', reason: 'Director information search unavailable', pageUrl: sourceUrl,
  } });
  assert.equal(rows[0].sourceUrl, sourceUrl);
  assert.equal(rows[0].status, 'search_unavailable');
});

test('a failed registry enrichment preserves its matched source on affected website rows', async () => {
  const rows = await run({
    website: true, leaders: [person('Asha Rao'), person('Bimal Shah')],
    websiteMatches: { 'Asha Rao': profileUrl },
    registryFailure: {
      ok: false, errorCode: 'SEARCH_UNAVAILABLE', reason: 'Director information search unavailable', pageUrl: sourceUrl,
    },
  });
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].sourceUrl, undefined);
  assert.equal(rows[1].sourceUrl, sourceUrl);
  assert.equal(rows[1].status, 'search_unavailable');
});

test('unsafe or non-registry page metadata is not emitted as a source link', async () => {
  for (const pageUrl of ['javascript:alert(1)', 'https://zaubacorp.com.evil.test/company', 'https://user:pass@www.zaubacorp.com/company', 'not a URL']) {
    const rows = await run({ registryFailure: {
      ok: false, errorCode: 'SEARCH_UNAVAILABLE', reason: 'Director information search unavailable', pageUrl,
    } });
    assert.equal(rows[0].sourceUrl, undefined);
  }
});
