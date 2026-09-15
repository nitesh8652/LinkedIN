const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
// Retain the real provider guards before replacing search for agent isolation.
const actualSearch = require('../src/search');
const { currentSearchConfig } = require('../src/search-config');

const companyName = 'Asterflux Biosciences Private Limited';
const brand = 'Asterflux Biosciences';
const profileUrl = 'https://www.linkedin.com/in/asha-rao-fixture';
let scenario = {};
const calls = [];
const forbidden = [];

function stub(name, exports) {
  const filename = path.resolve(__dirname, `../src/${name}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function unexpected(name) {
  return () => {
    forbidden.push(name);
    throw new Error(`${name} must not run in LinkedIn Direct mode`);
  };
}

stub('llm', {
  llmEnabled: unexpected('LLM configuration'),
  pickLinkedInWithLlm: unexpected('LLM validation'),
});
stub('search', {
  verifySearchProvider: async () => ({ ok: true, credits: 0 }),
  searchWeb: unexpected('web search'),
  searchWithFallbackQueries: async (buildQueries, options) => {
    if (!scenario.snippets) return unexpected('search API or fallback engines')();
    calls.push({ type: 'snippets', provider: currentSearchConfig().provider });
    return scenario.snippets();
  },
  closeSearchBrowser: async () => calls.push({ type: 'close-search' }),
});
stub('discover', { findOfficialWebsiteWithQueries: unexpected('official website discovery') });
stub('crawler', { crawlWebsiteForLeaders: unexpected('website crawl') });
stub('extract', { extractLeaders: unexpected('website leader extraction') });
stub('zaubacorp', {
  ZAUBA_SOURCE: 'ZaubaCorp', WEBSITE_SOURCE: 'Official Website',
  findDirectorsOnZaubaCorp: async (name) => {
    if (!scenario.zauba) return unexpected('ZaubaCorp lookup')();
    calls.push({ type: 'zauba', name, provider: currentSearchConfig().provider });
    return scenario.zauba;
  },
  verifyDirectorOnLinkedIn: unexpected('ZaubaCorp verification'),
  closeZaubaBrowser: async () => calls.push({ type: 'close-zauba' }),
});
stub('linkedin-direct', {
  getLinkedInStatus: async () => {
    calls.push({ type: 'direct-status' });
    return scenario.status || { configured: true, connected: true };
  },
  searchLinkedInDirect: async (options) => {
    calls.push({ type: 'direct', ...options });
    if (scenario.search) return scenario.search(options);
    if (scenario.error) throw scenario.error;
    return scenario.byPerson?.[options.personName] || scenario.results || [];
  },
});

// Keep the actual LinkedIn name/company validation in the integration path.
const { runAgent } = require('../src/agent');
const { findLinkedInProfile } = require('../src/linkedin');
const { withSearchConfig } = require('../src/search-config');

function makeJob() {
  const waiters = new Set();
  return {
    cancelled: false, logs: [], rows: [], progress: [], metadata: {},
    log(line) { this.logs.push(line); },
    setMeta(value) { Object.assign(this.metadata, value); },
    setProgress(value) { this.progress.push({ ...value }); },
    onRow(value) { this.rows.push(value); },
    onCancel(callback) {
      if (this.cancelled) callback();
      else waiters.add(callback);
      return () => waiters.delete(callback);
    },
    cancel() {
      this.cancelled = true;
      for (const callback of waiters) callback();
      waiters.clear();
    },
    get waiterCount() { return waiters.size; },
  };
}

function setup(options = {}) {
  scenario = options;
  calls.length = 0;
  forbidden.length = 0;
}

function personResult(name, employer = brand, role = 'Director') {
  return {
    name,
    title: `${name} - ${role} at ${employer}`,
    headline: `${role} at ${employer}`,
    snippet: `${role} at ${employer}`,
    url: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, '-')}-fixture`,
  };
}

function noExternalSearch() {
  assert.deepEqual(forbidden, [], 'direct mode must not use websites, registries, search engines, or LLMs');
}

test('real direct-provider preflight checks LinkedIn session status and generic web search cannot use APIs', async (t) => {
  t.mock.method(globalThis, 'fetch', unexpected('HTTP fetch'));
  setup();
  const connected = await withSearchConfig({ provider: 'linkedin' }, () => actualSearch.verifySearchProvider());
  assert.deepEqual(connected, { configured: true, ok: true });
  await assert.rejects(withSearchConfig({ provider: 'linkedin' }, () => actualSearch.searchWeb(`${brand} director`)),
    (error) => error.code === 'SEARCH_UNAVAILABLE' && /people search by director name and company/i.test(error.message));
  assert.deepEqual(calls.map((call) => call.type), ['direct-status']);
  noExternalSearch();

  setup({ status: { configured: true, connected: false, message: 'LinkedIn session requires sign-in' } });
  const disconnected = await withSearchConfig({ provider: 'linkedin' }, () => actualSearch.verifySearchProvider());
  assert.deepEqual(disconnected, { configured: true, ok: false, error: 'LinkedIn session requires sign-in' });
  assert.deepEqual(calls.map((call) => call.type), ['direct-status']);
  noExternalSearch();
});

test('supplied directors search LinkedIn with the company and skip website and ZaubaCorp discovery', async (t) => {
  t.mock.method(globalThis, 'fetch', unexpected('HTTP fetch'));
  setup({ byPerson: {
    'Asha Rao': [personResult('Asha Rao')],
    'Bimal Shah': [personResult('Bimal Shah', brand, 'Managing Director')],
  } });
  const job = makeJob();
  const rows = await runAgent([{ companyName, directors: [
    { name: 'Asha Rao', designation: 'Director' },
    { name: 'Bimal Shah', designation: 'Managing Director' },
  ] }], job, { provider: 'linkedin' });

  assert.deepEqual(rows.map((row) => [row.companyName, row.personName, row.status, row.source]), [
    [companyName, 'Asha Rao', 'ok', 'LinkedIn Direct'],
    [companyName, 'Bimal Shah', 'ok', 'LinkedIn Direct'],
  ]);
  assert.equal(rows[0].linkedinUrl, profileUrl);
  assert.equal(rows[0].sourceUrl, profileUrl);
  const searches = calls.filter((call) => call.type === 'direct');
  assert.deepEqual(searches.map(({ personName, companyName: company, designation }) => [personName, company, designation]), [
    ['Asha Rao', companyName, 'Director'], ['Bimal Shah', companyName, 'Managing Director'],
  ]);
  assert.equal(job.metadata.llmEnabled, false);
  assert.match(job.metadata.searchProvider, /LinkedIn Direct/);
  assert.deepEqual(job.progress, [
    { current: 1, completed: 0, company: companyName },
    { current: 1, completed: 1, company: null },
  ]);
  assert(!job.logs.some((line) => line.includes('[object Object]')));
  assert.deepEqual(rows, job.rows);
  noExternalSearch();
});

test('the actual name matcher rejects a namesake working at another company', async () => {
  const wrongCompany = personResult('Asha Rao', 'Different Biologics');
  setup({ results: [wrongCompany] });
  const result = await withSearchConfig({ provider: 'linkedin' }, () =>
    findLinkedInProfile('Asha Rao', companyName, 'Director'));
  assert.equal(result, null);
  const search = calls.find((call) => call.type === 'direct');
  assert.equal(search.accept(wrongCompany), false);
  assert.equal(search.accept(personResult('Asha Rao')), true);
  noExternalSearch();
});

test('company-only searches retain named leaders only when company and senior role share current evidence', async () => {
  const good = personResult('Asha Rao', brand, 'Managing Director');
  const headlineOnly = { ...personResult('Bimal Shah'), title: 'Bimal Shah', snippet: 'Bimal Shah' };
  const former = personResult('Chetan Das', brand, 'Former Director');
  const splitEvidence = {
    ...personResult('Priya Nair', 'Different Biologics'),
    snippet: `Director at Different Biologics\n${brand}`,
  };
  const junior = personResult('Anil Kumar', brand, 'Engineer');
  const companyPage = { ...good, url: 'https://www.linkedin.com/company/asterflux-biosciences' };
  const unnamed = { ...good, name: undefined, title: `Director at ${brand}` };
  setup({ results: [good, good, headlineOnly, former, splitEvidence, junior, companyPage, unnamed] });
  const job = makeJob();
  const rows = await runAgent([companyName], job, { provider: 'linkedin' });

  assert.deepEqual(rows.map((row) => [row.personName, row.designation, row.status]), [
    ['Asha Rao', 'Managing Director', 'ok'], ['Bimal Shah', 'Director', 'ok'],
  ]);
  const search = calls.find((call) => call.type === 'direct');
  assert.equal(search.companyName, companyName);
  assert.equal(search.personName, undefined);
  assert.equal(search.accept(good), true);
  for (const result of [former, splitEvidence, junior, companyPage, unnamed]) assert.equal(search.accept(result), false);
  assert.equal(job.waiterCount, 0, 'finished company scans unregister cancellation handlers');
  noExternalSearch();
});

test('ambiguous company-only results produce an explained empty match without inventing a person', async () => {
  setup({ results: [personResult('Asha Rao', 'Different Biologics')],
    zauba: { ok: false, directors: [], reason: 'ZaubaCorp page not found' }, snippets: () => [] });
  const rows = await runAgent([companyName], makeJob(), { provider: 'linkedin' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].personName, null);
  assert.equal(rows[0].linkedinUrl, null);
  assert.equal(rows[0].status, 'linkedin_unverified');
  assert.match(rows[0].reason, /Add a Director Name column/i);
  assert.deepEqual(calls.filter((call) => ['zauba', 'snippets'].includes(call.type)).map((call) => [call.type, call.provider]),
    [['zauba', 'searxng'], ['snippets', 'searxng']]);
  noExternalSearch();
});

test('a director role at another employer cannot transfer across headline clauses to this company', async () => {
  const ambiguous = ['; ', ' and ', ' & ', ' | ', ' \u2022 ', ', '].map((separator) => {
    const headline = `Director at Different Biologics${separator}Advisor at ${brand}`;
    return { ...personResult('Asha Rao'), title: `Asha Rao - ${headline}`, headline, snippet: headline };
  });
  const currentHeadline = `Director at ${brand} and Advisor at Different Biologics`;
  const currentDirector = {
    ...personResult('Priya Nair'), title: `Priya Nair - ${currentHeadline}`,
    headline: currentHeadline, snippet: currentHeadline,
  };
  setup({ results: [...ambiguous, currentDirector] });
  const rows = await runAgent([companyName], makeJob(), { provider: 'linkedin' });
  assert.deepEqual(rows.map((row) => [row.personName, row.designation]), [['Priya Nair', 'Director']]);
  const search = calls.find((call) => call.type === 'direct');
  for (const result of ambiguous) assert.equal(search.accept(result), false, result.headline);
  assert.equal(search.accept(currentDirector), true);
  noExternalSearch();
});

test('a comma between a director role and its employer keeps the association', async () => {
  const headline = `Managing Director, ${brand}`;
  setup({ results: [{ ...personResult('Asha Rao'), title: `Asha Rao - ${headline}`, headline, snippet: headline }] });
  const rows = await runAgent([companyName], makeJob(), { provider: 'linkedin' });
  assert.deepEqual(rows.map((row) => [row.personName, row.designation]), [['Asha Rao', 'Managing Director']]);
  noExternalSearch();
});

test('an unavailable LinkedIn session retains supplied director names and explains each missing URL', async () => {
  const message = 'LinkedIn Direct session expired. Connect LinkedIn and sign in again.';
  setup({ error: Object.assign(new Error(message), { code: 'SEARCH_UNAVAILABLE' }) });
  const rows = await runAgent([{ companyName, directors: [
    { name: 'Asha Rao', designation: 'Director' }, { name: 'Bimal Shah', designation: '' },
  ] }], makeJob(), { provider: 'linkedin' });
  assert.deepEqual(rows.map((row) => [row.personName, row.status, row.reason]), [
    ['Asha Rao', 'search_unavailable', message], ['Bimal Shah', 'search_unavailable', message],
  ]);
  assert(rows.every((row) => row.linkedinUrl === null && row.source === 'LinkedIn Direct'));
  assert.equal(calls.filter((call) => call.type === 'direct').length, 1, 'a disconnected session is not retried for every director');
  noExternalSearch();
});

test('unavailable company-only discovery preserves the direct-session error', async () => {
  const message = 'LinkedIn has temporarily limited this account. Try again later.';
  setup({ error: Object.assign(new Error(message), { code: 'SEARCH_UNAVAILABLE' }) });
  const job = makeJob();
  const rows = await runAgent([companyName], job, { provider: 'linkedin' });
  assert.equal(rows[0].status, 'search_unavailable');
  assert.equal(rows[0].source, 'LinkedIn Direct');
  assert.equal(rows[0].reason, message);
  assert.equal(job.waiterCount, 0);
  noExternalSearch();
});

test('weak direct matches return null without calling an LLM or consuming search API credits', async (t) => {
  t.mock.method(globalThis, 'fetch', unexpected('HTTP fetch'));
  setup({ results: [{ url: 'https://www.linkedin.com/in/unrelated-person', title: `Different Person - Director at ${brand}`, snippet: brand }] });
  const result = await withSearchConfig({ provider: 'linkedin' }, () =>
    findLinkedInProfile('Asha Rao', companyName, 'Director'));
  assert.equal(result, null);
  assert.equal(calls.filter((call) => call.type === 'direct').length, 1);
  noExternalSearch();
});

test('cancellation between supplied names keeps finished rows and stops further people and companies', async () => {
  const job = makeJob();
  setup({ search: () => {
    job.cancel();
    return [personResult('Asha Rao')];
  } });
  const rows = await runAgent([
    { companyName, directors: [{ name: 'Asha Rao' }, { name: 'Bimal Shah' }] },
    { companyName: 'Next Company', directors: [{ name: 'Priya Nair' }] },
  ], job, { provider: 'linkedin' });
  assert.deepEqual(rows.map((row) => row.personName), ['Asha Rao']);
  assert.equal(calls.filter((call) => call.type === 'direct').length, 1);
  assert.deepEqual(calls.filter((call) => call.type.startsWith('close-')).map((call) => call.type), ['close-search', 'close-zauba']);
  assert.equal(job.progress[0].company, companyName);
  noExternalSearch();
});

test('cancelling a pending supplied-name scan aborts it and retains only earlier completed names', async () => {
  const job = makeJob();
  let pendingSignal;
  setup({ search: ({ personName, signal }) => {
    assert.equal(job.waiterCount, 1, 'only the active lookup owns a cancellation handler');
    if (personName === 'Asha Rao') return [personResult('Asha Rao')];
    pendingSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true });
      job.cancel();
    });
  } });
  const rows = await runAgent([
    { companyName, directors: [{ name: 'Asha Rao' }, { name: 'Bimal Shah' }, { name: 'Chetan Das' }] },
    { companyName: 'Next Company', directors: [{ name: 'Priya Nair' }] },
  ], job, { provider: 'linkedin' });
  assert.equal(pendingSignal.aborted, true);
  assert.deepEqual(rows.map((row) => [row.personName, row.status]), [['Asha Rao', 'ok']]);
  assert.deepEqual(calls.filter((call) => call.type === 'direct').map((call) => call.personName), ['Asha Rao', 'Bimal Shah']);
  assert.deepEqual(rows, job.rows);
  assert.equal(job.waiterCount, 0);
  assert.deepEqual(calls.filter((call) => call.type.startsWith('close-')).map((call) => call.type), ['close-search', 'close-zauba']);
  noExternalSearch();
});

test('cancelling a company-only scan aborts the direct request without adding a failure row', async () => {
  const job = makeJob();
  let observedSignal;
  setup({ search: ({ signal }) => new Promise((resolve, reject) => {
    observedSignal = signal;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true });
    job.cancel();
  }) });
  const rows = await runAgent([companyName], job, { provider: 'linkedin' });
  assert.equal(observedSignal.aborted, true);
  assert.deepEqual(rows, []);
  assert.deepEqual(job.rows, []);
  assert.equal(job.waiterCount, 0);
  noExternalSearch();
});

test('when LinkedIn finds no director, SearXNG names are searched on LinkedIn with the company', async () => {
  const zaubaUrl = 'https://www.zaubacorp.com/company/ASTERFLUX-BIOSCIENCES/U00000#director-information';
  setup({
    search: ({ personName }) => personName === 'Asha Rao' ? [personResult('Asha Rao')] : [],
    zauba: { ok: true, pageUrl: zaubaUrl, matchedName: brand, confidence: 'high', directors: [
      { name: 'Asha Rao', designation: 'Director', din: '01234567', source: 'ZaubaCorp' },
      { name: 'Bimal Shah', designation: 'Managing Director', source: 'ZaubaCorp' },
      { name: 'asha  rao', designation: 'Director', source: 'ZaubaCorp' },
    ] },
  });
  const job = makeJob();
  const rows = await runAgent([companyName], job, { provider: 'linkedin' });

  assert.deepEqual(rows.map((row) => [row.personName, row.designation, row.linkedinUrl, row.status, row.source, row.sourceUrl]), [
    ['Asha Rao', 'Director', profileUrl, 'ok', 'ZaubaCorp', zaubaUrl],
    ['Bimal Shah', 'Managing Director', null, 'no_linkedin', 'ZaubaCorp', zaubaUrl],
  ]);
  assert.equal(rows[0].din, '01234567');
  const zauba = calls.find((call) => call.type === 'zauba');
  assert.deepEqual([zauba.name, zauba.provider], [companyName, 'searxng'], 'director names come from SearXNG');
  assert.deepEqual(calls.filter((call) => call.type === 'direct').map((call) => [call.personName, call.companyName]), [
    [undefined, companyName], ['Asha Rao', companyName], ['Bimal Shah', companyName],
  ]);
  assert.match(job.metadata.searchProvider, /LinkedIn Direct/);
  assert.equal(job.waiterCount, 0);
  noExternalSearch();
});

test('an unavailable SearXNG after an empty LinkedIn search is reported, not shown as no director', async () => {
  const message = 'SearXNG and its search fallbacks are temporarily unavailable: Cannot reach SearXNG';
  setup({ zauba: { ok: false, directors: [], reason: message, errorCode: 'SEARCH_UNAVAILABLE' },
    snippets: () => { throw Object.assign(new Error(message), { code: 'SEARCH_UNAVAILABLE' }); } });
  const rows = await runAgent([companyName], makeJob(), { provider: 'linkedin' });
  assert.deepEqual(rows.map((row) => [row.personName, row.status, row.source]), [[null, 'search_unavailable', 'SearXNG']]);
  assert.match(rows[0].reason, /Cannot reach SearXNG/);
  assert.equal(calls.filter((call) => call.type === 'direct').length, 1);
  noExternalSearch();
});
