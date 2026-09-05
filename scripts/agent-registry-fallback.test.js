const { test } = require('node:test');
const assert = require('node:assert/strict');

let scenario;
const calls = [];
const sourceUrl = 'https://www.zaubacorp.com/company#director-information';
function stub(name, exports) {
  const filename = require.resolve(`../src/${name}`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('llm', { llmEnabled: () => false });
stub('search', {
  verifySearchProvider: async () => ({ ok: true }),
  searchWeb: async () => [],
  searchWithFallbackQueries: async () => { calls.push('generic search'); return []; },
  closeSearchBrowser: async () => {},
});
stub('discover', { findOfficialWebsiteWithQueries: async () => {
  calls.push('website');
  return scenario.website ? { url: 'https://company.test' } : null;
} });
stub('crawler', { crawlWebsiteForLeaders: async () => ({ leaders: scenario.leaders || [], pagesVisited: ['https://company.test'] }) });
stub('extract', { extractLeaders: () => [] });
stub('linkedin', { findLinkedInProfile: async (name) => {
  calls.push(`website LinkedIn: ${name}`);
  return scenario.websiteMatches?.[name] || null;
} });
stub('zaubacorp', {
  ZAUBA_SOURCE: 'ZaubaCorp', WEBSITE_SOURCE: 'Official Website',
  findDirectorsOnZaubaCorp: async () => {
    calls.push('registry');
    return scenario.registryFailure ? { ok: false, reason: 'ZaubaCorp page not found' } : {
      ok: true, matchedName: 'Plasmagen Biosciences', confidence: 'high', pageUrl: sourceUrl,
      directors: scenario.directors || [{ name: 'Arnav Jain', designation: 'Director', din: '00001234' }],
    };
  },
  verifyDirectorOnLinkedIn: async (name, company) => {
    calls.push(`registry LinkedIn: ${company} ${name}`);
    return { url: scenario.registryMatches?.[name] || null, confidence: 'high' };
  },
  closeZaubaBrowser: async () => {},
});
const { runAgent } = require('../src/agent');
const person = (name) => ({ name, designation: 'Director' });
async function run(options) {
  scenario = options;
  calls.length = 0;
  const emitted = [];
  const rows = await runAgent(['Plasmagen Biosciences'], {
    log() {}, setMeta() {}, setProgress() {}, onRow: (row) => emitted.push(row),
  }, { provider: 'searxng' });
  assert.deepEqual(rows, emitted);
  return rows;
}

test('missing website goes straight to registry names before generic LinkedIn searches', async () => {
  const url = 'https://linkedin.com/in/arnav-jain-fixture';
  const rows = await run({ registryMatches: { 'Arnav Jain': url } });
  assert.deepEqual(calls, ['website', 'registry', 'registry LinkedIn: Plasmagen Biosciences Arnav Jain']);
  assert.equal(rows[0].linkedinUrl, url);
  assert.equal(rows[0].source, 'ZaubaCorp');
});

test('website names with no LinkedIn match trigger registry lookup and retain both sources', async () => {
  const rows = await run({ website: true, leaders: [person('Vinod Nahar')], registryMatches: { 'Arnav Jain': 'https://linkedin.com/in/arnav-jain-fixture' } });
  assert.ok(calls.indexOf('registry') > calls.indexOf('website LinkedIn: Vinod Nahar'));
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.personName === 'Vinod Nahar').linkedinUrl, null);
  assert.equal(rows.find((row) => row.personName === 'Arnav Jain').linkedinUrl, 'https://linkedin.com/in/arnav-jain-fixture');
});

test('partial website matches are preserved while registry names fill gaps without duplicate rows', async () => {
  const existingUrl = 'https://linkedin.com/in/asha-rao-fixture';
  const newUrl = 'https://linkedin.com/in/bimal-shah-fixture';
  const rows = await run({
    website: true, leaders: [person('Asha Rao'), person('Bimal Shah')], websiteMatches: { 'Asha Rao': existingUrl },
    directors: [person('ASHA RAO'), { ...person('BIMAL SHAH'), din: '00005678' }],
    registryMatches: { 'BIMAL SHAH': newUrl },
  });
  assert.equal(calls.filter((call) => call === 'registry').length, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].linkedinUrl, existingUrl);
  assert.equal(rows[0].source, 'Official Website');
  assert.equal(rows[1].linkedinUrl, newUrl);
  assert.equal(rows[1].din, '00005678');
  assert.equal(rows[1].source, 'ZaubaCorp');
});

test('all website directors with LinkedIn URLs skip ZaubaCorp', async () => {
  await run({ website: true, leaders: [person('Asha Rao'), person('Bimal Shah')], websiteMatches: {
    'Asha Rao': 'https://linkedin.com/in/asha-rao-fixture', 'Bimal Shah': 'https://linkedin.com/in/bimal-shah-fixture',
  } });
  assert.equal(calls.includes('registry'), false);
});

test('registry failure keeps existing director rows and is not retried within the company', async () => {
  const rows = await run({ website: true, leaders: [person('Asha Rao')], registryFailure: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].personName, 'Asha Rao');
  assert.equal(rows[0].status, 'no_linkedin');
  assert.equal(calls.filter((call) => call === 'registry').length, 1);
  const empty = await run({ registryFailure: true });
  assert.equal(empty[0].status, 'zauba_not_found');
  assert.equal(calls.filter((call) => call === 'registry').length, 1);
});

test('website with no extracted director names still uses registry names', async () => {
  const rows = await run({ website: true });
  assert.equal(rows[0].personName, 'Arnav Jain');
  assert.equal(rows[0].status, 'linkedin_unverified');
  assert.equal(calls.filter((call) => call === 'registry').length, 1);
});
