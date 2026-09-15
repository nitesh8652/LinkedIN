const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
process.env.SERPAPI_API_KEY = 'route-test-serpapi-key';

const capturedJobs = [];
let linkedInConnects = 0;
const linkedinPath = require.resolve('../src/linkedin-direct');
require.cache[linkedinPath] = { id: linkedinPath, filename: linkedinPath, loaded: true, exports: {
  async getLinkedInStatus() { return { status: 'connected', connected: true, message: 'LinkedIn connected' }; },
  async connectLinkedIn() { linkedInConnects++; return { status: 'login_required', connected: false, message: 'Sign in, then test the connection.' }; },
} };
const agentPath = require.resolve('../src/agent');
require.cache[agentPath] = { id: agentPath, filename: agentPath, loaded: true, exports: {
  async runAgent(companies, job, options) {
    let finish;
    const completion = new Promise((resolve) => { finish = resolve; });
    capturedJobs.push({ companies, options, finish });
    job.setMeta({ searchProvider: { linkedin: 'LinkedIn Direct', own: 'Own Search (SearXNG + direct engines)', searxng: 'SearXNG', serper: 'Serper (Google API)', serpapi: 'SerpApi (Google API)', hybrid: 'SerpApi + SearXNG (parallel)' }[options.provider] });
    await completion;
    const row = { companyName: companies[0], personName: 'Asha Rao', designation: 'Director', linkedinUrl: 'https://linkedin.com/in/asha-rao', source: 'ZaubaCorp', status: 'ok' };
    job.onRow(row);
    job.setProgress({ current: companies.length, completed: companies.length, company: null });
    return [row];
  },
} };
const app = require('../server');

test('settings, connection checks and upload routes respect the selected provider', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = globalThis.fetch;
  let searchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.origin === origin) return nativeFetch(input, options);
    if (url.origin === 'https://serpapi.com') {
      assert.equal(url.searchParams.get('api_key'), process.env.SERPAPI_API_KEY);
      searchCalls++;
      return new Response(JSON.stringify({ organic_results: [{ link: 'https://www.linkedin.com/', title: 'LinkedIn' }] }));
    }
    assert.equal(url.origin, 'http://127.0.0.1:8080', 'unexpected external or paid search request');
    assert.equal(url.pathname, '/search');
    searchCalls++;
    return new Response(JSON.stringify({ results: [{ url: 'https://www.linkedin.com/', title: 'LinkedIn' }] }), { headers: { 'Content-Type': 'application/json' } });
  });

  const settings = await (await fetch(`${origin}/api/search-config`)).json();
  assert.ok(['linkedin', 'own', 'serper', 'serpapi', 'searxng', 'hybrid'].includes(settings.provider));
  assert.equal(searchCalls, 0, 'loading settings must not spend credits');
  assert.equal(JSON.stringify(settings).includes('SERPER_API_KEY'), false);
  assert.deepEqual(settings.serpapi, { configured: true });
  assert.equal(JSON.stringify(settings).includes(process.env.SERPAPI_API_KEY), false);
  const legacyCheck = await (await fetch(`${origin}/api/serper-check`)).json();
  assert.equal(legacyCheck.skipped, true);
  assert.equal(searchCalls, 0, 'legacy automatic probes must not spend credits');

  const linkedinStatus = await (await fetch(`${origin}/api/linkedin/status`)).json();
  assert.equal(linkedinStatus.connected, true);
  assert.equal(linkedInConnects, 0, 'reading LinkedIn status must not launch a browser');
  for (const foreignOrigin of ['https://unrelated.example', 'null', 'not-an-origin']) {
    const rejected = await fetch(`${origin}/api/linkedin/connect`, { method: 'POST', headers: { Origin: foreignOrigin } });
    assert.equal(rejected.status, 403);
    const rejectedCheck = await fetch(`${origin}/api/search-check`, {
      method: 'POST', headers: { Origin: foreignOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'linkedin' }),
    });
    assert.equal(rejectedCheck.status, 403);
  }
  assert.equal(linkedInConnects, 0, 'foreign origins must not launch a browser');
  const linkedinConnect = await fetch(`${origin}/api/linkedin/connect`, { method: 'POST', headers: { Origin: origin } });
  assert.equal(linkedinConnect.status, 200);
  assert.equal((await linkedinConnect.json()).connected, false);
  assert.equal(linkedInConnects, 1);
  const linkedinCheck = await (await fetch(`${origin}/api/search-check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'linkedin' }),
  })).json();
  assert.equal(linkedinCheck.ok, true);
  assert.equal(linkedinCheck.provider, 'linkedin');
  assert.equal(searchCalls, 0, 'LinkedIn connection checks must not spend search credits');

  const check = await (await fetch(`${origin}/api/search-check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'searxng', searxngUrl: 'http://127.0.0.1:8080' }),
  })).json();
  assert.equal(check.ok, true);
  assert.equal(check.provider, 'searxng');
  assert.equal(searchCalls, 1);

  const invalid = await fetch(`${origin}/api/search-check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'invalid' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(searchCalls, 1);

  const serpapiCheck = await (await fetch(`${origin}/api/search-check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'serpapi' }),
  })).json();
  assert.equal(serpapiCheck.ok, true);
  assert.equal(serpapiCheck.provider, 'serpapi');
  assert.equal(searchCalls, 2);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Companies');
  sheet.addRow(['Company Name']);
  sheet.addRow(['Acme Industries']);
  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `provider-route-test-${process.pid}.xlsx`;
  const outputFiles = [];
  t.after(async () => {
    const uploads = path.join(__dirname, '..', 'uploads');
    for (const name of await fs.readdir(uploads)) {
      if (name.endsWith(`-${filename}`)) await fs.unlink(path.join(uploads, name));
    }
    for (const output of outputFiles) await fs.unlink(output).catch(() => {});
  });
  for (const provider of ['searxng', 'serper', 'serpapi', 'hybrid', 'own', 'linkedin', 'invalid']) {
    const form = new FormData();
    form.append('excel', new Blob([buffer]), filename);
    form.append('searchProvider', provider);
    form.append('searxngUrl', 'http://127.0.0.1:8080/prefix');
    if (provider === 'linkedin') {
      const before = capturedJobs.length;
      const forbidden = await fetch(`${origin}/api/upload`, { method: 'POST', headers: { Origin: 'https://unrelated.example' }, body: form });
      assert.equal(forbidden.status, 403);
      assert.equal(capturedJobs.length, before, 'foreign origins cannot use the saved LinkedIn session to scan');
    }
    const res = await fetch(`${origin}/api/upload`, { method: 'POST', body: form });
    if (provider === 'invalid') {
      assert.equal(res.status, 400);
      continue;
    }
    assert.equal(res.status, 200);
    const { jobId } = await res.json();
    const busyConnect = await fetch(`${origin}/api/linkedin/connect`, { method: 'POST' });
    assert.equal(busyConnect.status, 409, 'LinkedIn session must stay unchanged while a job is running');
    assert.equal(linkedInConnects, 1);
    outputFiles.push(path.join(__dirname, '..', 'outputs', `report-${jobId.slice(0, 8)}.xlsx`));
    const live = await fetch(`${origin}/api/events/${jobId}`, { signal: AbortSignal.timeout(2000) });
    const liveBody = live.text();
    capturedJobs.at(-1).finish();
    const liveEvents = (await liveBody).trim().split('\n\n').map((line) => JSON.parse(line.slice(6)));
    assert.equal(liveEvents.at(-1).state.status, 'done', 'active SSE must close when the report is ready');
    assert.ok(liveEvents.some((event) => event.state?.status === 'finalizing'));
    assert.equal(liveEvents.filter((event) => event.type === 'row').length, 1);
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await (await fetch(`${origin}/api/status/${jobId}`)).json();
      if (['done', 'error'].includes(state.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(state.status, 'done');
    assert.match(state.meta.searchProvider, { linkedin: /LinkedIn Direct/, own: /Own Search/, searxng: /SearXNG/, serper: /Serper/, serpapi: /SerpApi/, hybrid: /SerpApi \+ SearXNG/ }[provider]);
    const replay = await fetch(`${origin}/api/events/${jobId}`, { signal: AbortSignal.timeout(2000) });
    const events = (await replay.text()).trim().split('\n\n').map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(events.map((event) => event.type), ['logs', 'rows', 'state']);
    assert.equal(events[1].rows.length, 1);
    assert.equal(events.at(-1).state.status, 'done', 'completed SSE replay must end after sending data');
  }
  assert.equal(capturedJobs.length, 6);
  assert.deepEqual(capturedJobs.map((job) => job.options.provider), ['searxng', 'serper', 'serpapi', 'hybrid', 'own', 'linkedin']);
  assert.equal(capturedJobs[0].options.searxngUrl, 'http://127.0.0.1:8080/prefix/search');
  assert.deepEqual(capturedJobs[0].companies, ['Acme Industries']);
  assert.equal(searchCalls, 2, 'uploads with a stubbed agent must not run hidden paid checks');
});
