const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

let scenario;
const searchCalls = [];
const searchFile = require.resolve('../src/search');
require.cache[searchFile] = { id: searchFile, filename: searchFile, loaded: true, exports: {
  searchWithFallbackQueries: async (buildQueries) => {
    searchCalls.push(buildQueries());
    return searchCalls.length === 1 ? scenario.results : (scenario.extraResults || []);
  },
} };
const { parseDirectorsFromSearchResults, findDirectorsOnZaubaCorp, closeZaubaBrowser } = require('../src/zaubacorp');

const companyName = 'TIMES COMTRADE PRIVATE LIMITED';
const companyUrl = 'https://www.zaubacorp.com/TIMES-COMTRADE-PRIVATE-LIMITED-U34100GJ2006PTC049120';
const companyResult = (snippet = '') => ({ url: companyUrl, title: companyName, snippet });
const directorResult = (snippet, name = 'JITENDRA JAYANTILAL SHAH', din = '00127490') => ({
  url: `https://www.zaubacorp.com/${name.replace(/ /g, '-')}-${din}`,
  title: `${name} | ZaubaCorp`, snippet,
});
const activeResult = () => directorResult(
  'Companies Associated With ; TIMES COMTRADE PRIVATE LIMITED, Director, 20-Sep-2006 ; ORIENS SOLAR ENERGY PRIVATE LIMITED, Director, 01-Jan-2010'
);

test('company summary provides explicit names with traceable indexed source', () => {
  const directors = parseDirectorsFromSearchResults([
    companyResult('Directors of TIMES COMTRADE PRIVATE LIMITED are JITENDRA JAYANTILAL SHAH and DILIP SHAH. Registration details follow.'),
    activeResult(),
  ], companyName);
  assert.deepEqual(directors.map((person) => person.name), ['JITENDRA JAYANTILAL SHAH', 'DILIP SHAH']);
  assert.equal(directors[0].source, 'ZaubaCorp (search result)');
  assert.equal(directors[0].sourceUrl, companyUrl, 'company summary remains the preferred source');
  assert.equal(directors[0].designation, 'Director');
});

test('current director association supplies its explicit role, DIN and appointment date', () => {
  const result = activeResult();
  assert.deepEqual(parseDirectorsFromSearchResults([result], companyName), [{
    name: 'JITENDRA JAYANTILAL SHAH', designation: 'Director', din: '00127490', appointmentDate: '20-Sep-2006',
    source: 'ZaubaCorp (search result)', sourceUrl: result.url,
  }]);
});

test('past associations, unrelated companies and titles without an association are rejected', () => {
  const snippets = [
    'Past Companies Associated With ; TIMES COMTRADE PRIVATE LIMITED, Director, 20-Sep-2006',
    'Companies Associated With ; ORIENS SOLAR ENERGY PRIVATE LIMITED, Director, 01-Jan-2010 ; Past Companies Associated With ; TIMES COMTRADE PRIVATE LIMITED, Director, 20-Sep-2006',
    'Companies Associated With ; TIMES COMTRADE PRIVATE LIMITED, Former Director, 20-Sep-2006',
    'Companies Associated With ; TIMES COMTRADE PRIVATE LIMITED, Company Secretary, 20-Sep-2006',
    'Companies Associated With ; TIMES GREEN POWER PRIVATE LIMITED, Director, 20-Sep-2006',
    'JITENDRA JAYANTILAL SHAH works with TIMES COMTRADE PRIVATE LIMITED',
  ];
  for (const snippet of snippets) assert.deepEqual(parseDirectorsFromSearchResults([directorResult(snippet)], companyName), [], snippet);
});

test('company snippets must explicitly identify this company and current directors', () => {
  const results = [
    companyResult('Former Directors of TIMES COMTRADE PRIVATE LIMITED are APURVA SHAH.'),
    companyResult('Directors of TIMES GREEN POWER PRIVATE LIMITED are APURVA SHAH.'),
    companyResult('TIMES COMTRADE PRIVATE LIMITED has several directors, including useful company information.'),
    { ...activeResult(), title: 'DILIP SHAH | ZaubaCorp' },
    { ...activeResult(), url: 'https://zaubacorp.com.example.test/JITENDRA-JAYANTILAL-SHAH-00127490' },
  ];
  assert.deepEqual(parseDirectorsFromSearchResults(results, companyName), []);
});

function mockRegistry(t, options) {
  scenario = options;
  searchCalls.length = 0;
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => nativeTimeout(callback, ms < 12000 ? 0 : ms, ...args));
  let pageLoads = 0;
  const locator = { first() { return this; }, async waitFor() {}, async evaluate() {} };
  const page = {
    isClosed: () => false, async route() {}, async waitForTimeout() {},
    async goto(url) { pageLoads++; assert.equal(url, `${companyUrl}#director-information`); return { status: () => options.blocked ? 403 : 200 }; },
    async evaluate(fn) {
      if (String(fn).includes("document.getElementById('director-information')")) {
        return { present: /id="director-information"/.test(options.html || ''), clicked: false };
      }
      return options.blocked ? 'Just a moment. Checking your browser.' : 'Company details';
    },
    locator: () => locator, async waitForFunction() {}, async content() { return options.html || '<p>Company details</p>'; },
  };
  t.mock.method(chromium, 'launch', async () => ({
    async newContext() { return { async addInitScript() {}, async newPage() { return page; } }; },
    async close() {},
  }));
  t.after(closeZaubaBrowser);
  return { pageLoads: () => pageLoads };
}

test('Cloudflare-blocked matched page recovers company directors already indexed in search', async (t) => {
  const browser = mockRegistry(t, { blocked: true, results: [companyResult(), activeResult()] });
  const result = await findDirectorsOnZaubaCorp(companyName);
  assert.equal(result.ok, true);
  assert.equal(result.directors[0].name, 'JITENDRA JAYANTILAL SHAH');
  assert.equal(result.directors[0].sourceUrl, activeResult().url);
  assert.equal(searchCalls.length, 1, 'reuse existing evidence before running another query');
  assert.equal(browser.pageLoads(), 3, 'try loading the primary registry page first');
});

test('one focused registry search can recover names when the page has no Directors section', async (t) => {
  mockRegistry(t, { results: [companyResult()], extraResults: [activeResult()] });
  const result = await findDirectorsOnZaubaCorp(companyName);
  assert.equal(result.ok, true);
  assert.equal(searchCalls.length, 2);
  assert.deepEqual(searchCalls[1], [`site:zaubacorp.com "${companyName}" "Director"`]);
  assert.equal(result.directors[0].source, 'ZaubaCorp (search result)');
});

test('an explicitly present empty Directors section is never replaced by indexed names', async (t) => {
  mockRegistry(t, {
    html: '<section id="director-information"><h2>Directors</h2><p>No directors available</p></section>',
    results: [companyResult(), activeResult()],
  });
  const result = await findDirectorsOnZaubaCorp(companyName);
  assert.equal(result.ok, false);
  assert.deepEqual(result.directors, []);
  assert.equal(searchCalls.length, 1);
});

test('loaded Directors section takes priority over indexed names', async (t) => {
  mockRegistry(t, {
    html: '<section id="director-information"><h2>Directors</h2><table><tr><th>DIN</th><th>Name</th><th>Designation</th></tr><tr><td>00005678</td><td>DILIP SHAH</td><td>Director</td></tr></table></section>',
    results: [companyResult(), activeResult()],
  });
  const result = await findDirectorsOnZaubaCorp(companyName);
  assert.equal(result.ok, true);
  assert.deepEqual(result.directors.map((person) => person.name), ['DILIP SHAH']);
  assert.equal(result.directors[0].source, 'ZaubaCorp');
  assert.equal(searchCalls.length, 1);
});
