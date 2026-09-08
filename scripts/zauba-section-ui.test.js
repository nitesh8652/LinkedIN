const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { withSearchConfig } = require('../src/search-config');
const { findDirectorsOnZaubaCorp, closeZaubaBrowser, openDirectorInformation } = require('../src/zaubacorp');

test('SearXNG company result opens the Directors fragment, expands its panel and waits for director rows', async (t) => {
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures/zauba-directors.html'), 'utf8');
  const companyUrl = 'https://www.zaubacorp.com/ACME-FOODS-PRIVATE-LIMITED-U12345AA2000PTC123456';
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await closeZaubaBrowser(); await browser.close(); });
  const createContext = browser.newContext.bind(browser);
  const navigations = [];
  let companyPage;
  t.mock.method(chromium, 'launch', async () => browser);
  t.mock.method(browser, 'newContext', async (options) => {
    const context = await createContext(options);
    const newPage = context.newPage.bind(context);
    t.mock.method(context, 'newPage', async () => {
      const page = await newPage();
      companyPage = page;
      const goto = page.goto.bind(page);
      t.mock.method(page, 'goto', async (url, options) => {
        navigations.push(url);
        await page.route('**/*', (route) => {
          assert.equal(new URL(route.request().url()).hostname, 'www.zaubacorp.com');
          return route.fulfill({ contentType: 'text/html', body: fixture });
        });
        return goto(url, options);
      });
      return page;
    });
    return context;
  });
  const searchOrigins = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    searchOrigins.push(url.origin);
    return new Response(JSON.stringify({ results: [{
      url: companyUrl, title: 'ACME FOODS PRIVATE LIMITED | ZaubaCorp', content: 'Company information',
    }] }));
  });
  const logs = [];
  const result = await withSearchConfig({ provider: 'searxng', searxngUrl: 'http://localhost:8080' }, () =>
    findDirectorsOnZaubaCorp('Acme Foods Private Limited', (line) => logs.push(line)));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.pageUrl, `${companyUrl}#director-information`);
  assert.deepEqual(navigations, [`${companyUrl}#director-information`]);
  assert.deepEqual(searchOrigins, ['http://localhost:8080'], 'navigate after a matching SearXNG result; never call Serper');
  assert.deepEqual(result.directors.map((person) => person.name), ['ASHA RAO', 'BIMAL SHAH']);
  assert.equal(result.directors[0].din, '00001234');
  assert.equal(result.directors[0].appointmentDate, '20/09/2006');
  assert.ok(logs.some((line) => line.includes('opening ZaubaCorp Directors (#director-information)')));
  assert.equal(await companyPage.locator('#director-panel').isVisible(), true);
  await openDirectorInformation(companyPage);
  assert.equal(await companyPage.locator('#director-panel').isVisible(), true, 'reopening must not collapse an expanded section');

  await companyPage.setContent('<h2 id="director-information">Directors</h2><table><tr><td>Asha Rao</td></tr></table>');
  const headingLogs = [];
  await openDirectorInformation(companyPage, (line) => headingLogs.push(line));
  assert.ok(headingLogs.every((line) => !line.includes('timeout')), 'heading anchors must recognize the following table');
});
