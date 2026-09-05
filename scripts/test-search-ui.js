const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const app = require('../server');

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    const checks = [];
    let uploads = 0;
    let polls = 0;
    let pollStreams = 0;
    const row = { companyName: 'Acme', personName: 'Asha Rao', designation: 'Director', linkedinUrl: 'https://linkedin.com/in/asha-rao', source: 'ZaubaCorp', status: 'ok', din: '00001234', appointmentDate: '20/09/2006', sourceUrl: 'https://www.zaubacorp.com/company#director-information' };
    const event = (type, data) => `data: ${JSON.stringify({ type, ...data })}\n\n`;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/serper-check') throw new Error('Unexpected automatic Serper check');
      if (url.pathname === '/api/search-config') return route.fulfill({ json: {
        provider: 'serper', searxngUrl: 'http://localhost:8080/search', serper: { configured: true },
      } });
      if (url.pathname === '/api/search-check') {
        checks.push(request.postDataJSON());
        return route.fulfill({ json: { provider: checks.at(-1).provider, ok: true } });
      }
      if (url.pathname === '/api/upload') {
        assert.match(request.postDataBuffer().toString(), /name="searchProvider"\r\n\r\nsearxng/);
        assert.match(request.postDataBuffer().toString(), /http:\/\/localhost:9999/);
        const jobId = ['ui-test', 'ui-poll', 'ui-error'][uploads++];
        return route.fulfill({ json: { jobId, companiesFound: 2, companies: ['Acme', 'Fable'] } });
      }
      if (url.pathname === '/api/events/ui-test') return route.fulfill({
        contentType: 'text/event-stream',
        body: event('logs', { lines: ['DONE - report ready for download'] }) +
          event('rows', { rows: [row] }) +
          event('state', { state: { status: 'done', hasOutput: true, meta: { searchProvider: 'SearXNG' } } }),
      });
      if (url.pathname === '/api/events/ui-poll') {
        pollStreams++;
        return route.fulfill({ contentType: 'text/event-stream', body:
          event('rows', { rows: [row] }) + event('logs', { lines: ['First company fetched'] }) +
          event('state', { state: { status: 'running', rowsCount: 1, progress: { current: 2, total: 2, completed: 1, company: 'Fable' } } }),
        });
      }
      if (url.pathname === '/api/status/ui-poll') {
        polls++;
        if (polls === 1) return route.fulfill({ status: 503, json: { error: 'Temporary failure' } });
        const status = polls >= 4 ? 'done' : polls === 3 ? 'finalizing' : 'running';
        return route.fulfill({ json: {
          status, rowsCount: 1, rows: [row], logs: status === 'done' ? ['First company fetched', 'DONE - report ready for download'] : ['First company fetched'],
          progress: { current: 2, total: 2, completed: status === 'running' ? 1 : 2, company: status === 'running' ? 'Fable' : null },
          meta: { searchProvider: 'SearXNG' }, hasOutput: status === 'done',
        } });
      }
      if (url.pathname === '/api/events/ui-error') return route.fulfill({ contentType: 'text/event-stream', body:
        event('logs', { lines: ['FATAL: test failure'] }) + event('rows', { rows: [row] }) +
        event('state', { state: { status: 'error', error: 'test failure', progress: { current: 2, total: 2, completed: 1, company: null } } }),
      });
      if (url.pathname.startsWith('/api/status/')) throw new Error('Unexpected polling after terminal state');
      return route.continue();
    });
    await page.goto(origin);
    await page.waitForFunction(() => !document.getElementById('checkSearchBtn').disabled);
    assert.equal(checks.length, 0);
    await page.getByRole('button', { name: 'SearXNG No Serper credits' }).click();
    await page.getByLabel('SearXNG instance URL').fill('http://localhost:9999');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.waitForFunction(() => document.getElementById('searchStatus').dataset.state === 'ok');
    assert.deepEqual(checks, [{ provider: 'searxng', searxngUrl: 'http://localhost:9999' }]);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('checkSearchBtn').disabled);
    assert.equal(await page.locator('[data-provider="searxng"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('SearXNG instance URL').inputValue(), 'http://localhost:9999');
    assert.equal(checks.length, 1, 'reload must not perform another search');
    await page.locator('#fileInput').setInputFiles({ name: 'companies.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('mocked upload') });
    await page.getByRole('button', { name: 'Upload & Start Processing' }).click();
    await page.waitForFunction(() => document.getElementById('jobSearchProvider').textContent === 'Search: SearXNG');
    assert.equal(await page.locator('#resultsTable tbody tr').count(), 1, 'completed replay must preserve rows');
    assert.equal(await page.locator('#statLinkedin').textContent(), '1');
    assert.equal(await page.locator('#resultsTable tbody tr td').nth(6).textContent(), '00001234');
    assert.equal(await page.locator('#resultsTable tbody tr td').nth(7).textContent(), '20/09/2006');
    assert.equal(await page.getByRole('link', { name: 'ZaubaCorp', exact: true }).getAttribute('href'), row.sourceUrl);
    assert.equal(await page.locator('#downloadBtn').getAttribute('href'), '/api/download/ui-test');

    await page.getByRole('button', { name: 'Upload & Start Processing' }).click();
    await page.waitForFunction(() => document.getElementById('currentCompanyName').textContent === 'Researching: Fable');
    assert.equal(await page.locator('#percentText').textContent(), '50%', 'last company must not start at 100%');
    await page.waitForFunction(() => document.getElementById('progressText').textContent === 'All companies fetched. Preparing report...');
    assert.equal(await page.locator('#percentText').textContent(), '99%');
    await page.waitForFunction(() => document.getElementById('progressText').textContent === 'Complete!');
    assert.equal(await page.locator('#percentText').textContent(), '100%');
    assert.equal(await page.locator('#resultsTable tbody tr').count(), 1, 'poll snapshots must not duplicate rows');
    assert.equal(await page.locator('#statLinkedin').textContent(), '1');
    assert.equal(await page.locator('#logBox > div').count(), 2, 'poll snapshots must not duplicate logs');
    assert.equal(await page.locator('#currentCompany').isVisible(), false);
    const finalPolls = polls;
    await page.waitForTimeout(2500);
    assert.equal(polls, finalPolls, 'polling must stop on completion');
    assert.equal(pollStreams, 1, 'SSE must not reconnect alongside polling');

    await page.getByRole('button', { name: 'Upload & Start Processing' }).click();
    await page.waitForFunction(() => document.getElementById('progressText').textContent === 'Failed.');
    assert.equal(await page.locator('#percentText').textContent(), '50%', 'failed jobs must not show 100%');
    assert.equal(await page.locator('#resultsTable tbody tr').count(), 1);
    assert.equal(await page.locator('#statLinkedin').textContent(), '1', 'new uploads must reset counters');
    assert.match(await page.locator('#logBox').textContent(), /FATAL: test failure/);
    await page.getByRole('button', { name: 'Serper Uses API credits' }).click();
    assert.equal(await page.locator('#searxngSettings').isVisible(), false);
    assert.equal(await page.locator('#jobSearchProvider').textContent(), 'Search: SearXNG');
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS: provider controls, completed replay, accurate progress, polling retries without duplicates, terminal shutdown, counter resets, and mobile layout');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
