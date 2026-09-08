const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

let scenario = {};
const calls = [];
const unavailable = () => Object.assign(new Error('SearXNG search engines are temporarily unavailable; retry later'), { code: 'SEARCH_UNAVAILABLE' });
function stub(name, exports) {
  const filename = require.resolve(`../src/${name}`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('llm', { llmEnabled: () => false });
stub('search', {
  verifySearchProvider: async () => ({ ok: true, warnings: scenario.warnings || [] }),
  searchWeb: async () => [],
  searchWithFallbackQueries: async () => {
    calls.push('generic search');
    if (scenario.genericUnavailable) throw unavailable();
    return [];
  },
  closeSearchBrowser: async () => calls.push('close search'),
});
stub('discover', { findOfficialWebsiteWithQueries: async () => {
  calls.push('website');
  if (scenario.discoveryUnavailable) throw unavailable();
  return scenario.website ? { url: 'https://company.test' } : null;
} });
stub('crawler', { crawlWebsiteForLeaders: async () => ({ leaders: scenario.leaders || [], pagesVisited: ['https://company.test'] }) });
stub('extract', { extractLeaders: () => [] });
stub('linkedin', { findLinkedInProfile: async (name) => {
  calls.push(`website LinkedIn: ${name}`);
  if (scenario.websiteUnavailable === name) throw unavailable();
  return scenario.websiteMatches?.[name] || null;
} });
stub('zaubacorp', {
  ZAUBA_SOURCE: 'ZaubaCorp', WEBSITE_SOURCE: 'Official Website',
  findDirectorsOnZaubaCorp: async () => {
    calls.push('registry');
    if (scenario.registryUnavailable) return { ok: false, errorCode: 'SEARCH_UNAVAILABLE', reason: unavailable().message };
    if (scenario.registryFailure) return { ok: false, reason: 'ZaubaCorp page not found' };
    return { ok: true, matchedName: 'Plasmagen Biosciences', confidence: 'high',
      pageUrl: 'https://www.zaubacorp.com/company#director-information', directors: scenario.directors || [] };
  },
  verifyDirectorOnLinkedIn: async (name) => {
    calls.push(`registry LinkedIn: ${name}`);
    if (scenario.registryProfileUnavailable === name) throw unavailable();
    return { url: scenario.registryMatches?.[name] || null, confidence: 'high' };
  },
  closeZaubaBrowser: async () => calls.push('close registry'),
});
const { runAgent } = require('../src/agent');
const { writeResultsToExcel } = require('../src/excel');
const person = (name, linkedinUrl = null) => ({ name, designation: 'Director', linkedinUrl });
const foundUrl = 'https://linkedin.com/in/asha-rao-fixture';
async function run(options) {
  scenario = options;
  calls.length = 0;
  const emitted = [];
  const logs = [];
  const progress = [];
  const rows = await runAgent(['Plasmagen Biosciences'], {
    log: (line) => logs.push(line), setMeta() {},
    setProgress: (value) => progress.push(value), onRow: (row) => emitted.push(row),
  }, { provider: 'searxng' });
  assert.deepEqual(rows, emitted);
  assert.deepEqual(calls.slice(-2), ['close search', 'close registry']);
  assert.equal(progress.at(-1).completed, 1);
  assert.equal(progress.at(-1).company, null);
  return { rows, logs };
}

test('website discovery outages are distinguished from genuine missing companies', async () => {
  const { rows } = await run({ discoveryUnavailable: true });
  assert.equal(rows[0].status, 'search_unavailable');
  assert.equal(rows[0].personName, null);
  assert.match(rows[0].reason, /temporarily unavailable/);
  assert.equal(calls.includes('registry'), false);
});

test('website profile outages preserve all known names and earlier URLs without registry retries', async () => {
  const { rows } = await run({ website: true,
    leaders: [person('Asha Rao'), person('Bimal Shah'), person('Chetan Das')],
    websiteMatches: { 'Asha Rao': foundUrl }, websiteUnavailable: 'Bimal Shah' });
  assert.deepEqual(rows.map((row) => row.personName), ['Asha Rao', 'Bimal Shah', 'Chetan Das']);
  assert.deepEqual(rows.map((row) => row.status), ['ok', 'search_unavailable', 'search_unavailable']);
  assert.equal(rows[0].linkedinUrl, foundUrl);
  assert.equal(calls.includes('website LinkedIn: Chetan Das'), false);
  assert.equal(calls.includes('registry'), false);
});

test('an unavailable supplemental name search cannot erase an extracted website director', async () => {
  const { rows } = await run({ website: true, leaders: [person('Sethu Madhavan')], genericUnavailable: true });
  assert.equal(rows[0].personName, 'Sethu Madhavan');
  assert.equal(rows[0].status, 'search_unavailable');
  assert.equal(calls.filter((call) => call === 'generic search').length, 1);
  assert.equal(calls.includes('registry'), false);
  assert.equal(calls.includes('website LinkedIn: Sethu Madhavan'), false);
});

test('an unavailable supplemental name search preserves an existing profile URL', async () => {
  const { rows } = await run({ website: true, leaders: [person('Asha Rao', foundUrl)], genericUnavailable: true });
  assert.equal(rows[0].linkedinUrl, foundUrl);
  assert.equal(rows[0].status, 'ok');
});

test('a registry name-search outage stops further searches and records the right status', async () => {
  const { rows } = await run({ registryUnavailable: true });
  assert.equal(rows[0].status, 'search_unavailable');
  assert.equal(rows[0].source, 'ZaubaCorp');
  assert.equal(calls.includes('generic search'), false);
});

test('registry profile outages retain every director and preserve completed matches', async () => {
  const { rows } = await run({
    directors: [person('Asha Rao'), person('Bimal Shah'), person('Chetan Das')],
    registryMatches: { 'Asha Rao': foundUrl }, registryProfileUnavailable: 'Bimal Shah',
  });
  assert.deepEqual(rows.map((row) => row.personName), ['Asha Rao', 'Bimal Shah', 'Chetan Das']);
  assert.deepEqual(rows.map((row) => row.status), ['ok', 'search_unavailable', 'search_unavailable']);
  assert.equal(rows[0].linkedinUrl, foundUrl);
  assert.equal(calls.includes('registry LinkedIn: Chetan Das'), false);
});

test('a failed registry enrichment preserves website names and records the incomplete search', async () => {
  const { rows } = await run({ website: true, leaders: [person('Asha Rao'), person('Bimal Shah')],
    websiteMatches: { 'Asha Rao': foundUrl }, registryUnavailable: true });
  assert.equal(rows[0].linkedinUrl, foundUrl);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[1].personName, 'Bimal Shah');
  assert.equal(rows[1].status, 'search_unavailable');
});

test('genuine missing profiles retain no-match statuses when search is available', async () => {
  const website = await run({ website: true, leaders: [person('Asha Rao'), person('Bimal Shah')], registryFailure: true });
  assert.ok(website.rows.every((row) => row.status === 'no_linkedin'));
  const registry = await run({ directors: [person('Asha Rao')] });
  assert.equal(registry.rows[0].status, 'linkedin_unverified');
});

test('startup reports limited engine availability without claiming a fully healthy search', async () => {
  const { logs } = await run({ registryFailure: true, warnings: ['google: CAPTCHA'] });
  assert.ok(logs.some((line) => line.includes('connected with limited engines')));
  assert.ok(logs.some((line) => line.includes('google: CAPTCHA')));
  assert.equal(logs.some((line) => line === 'Search: SearXNG OK'), false);
});

test('Excel output labels unavailable searches and preserves the director name', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-search-unavailable-'));
  const output = path.join(directory, 'report.xlsx');
  t.after(async () => { await fs.rm(output, { force: true }); await fs.rmdir(directory); });
  await writeResultsToExcel([{ companyName: 'Plasmagen Biosciences', personName: 'Sethu Madhavan',
    designation: 'Chief Operating Officer', linkedinUrl: null, status: 'search_unavailable' }], output);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  const row = workbook.getWorksheet('Directors Report').getRow(2);
  assert.equal(row.getCell(2).value, 'Sethu Madhavan');
  assert.equal(row.getCell(6).value, 'Search temporarily unavailable');
});
