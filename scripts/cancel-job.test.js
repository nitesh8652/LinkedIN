const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');

// A stub agent that behaves like the real one: it emits a row per company and
// stops at the next boundary once the job is cancelled.
const capturedJobs = [];
const agentPath = require.resolve('../src/agent');
require.cache[agentPath] = { id: agentPath, filename: agentPath, loaded: true, exports: {
  async runAgent(companies, job) {
    capturedJobs.push(job);
    job.setMeta({ total: companies.length, searchProvider: 'SearXNG' });
    const rows = [];
    for (let i = 0; i < companies.length; i++) {
      if (job.cancelled) {
        job.log(`Cancelled - stopped after ${i} of ${companies.length} companies`);
        break;
      }
      const row = { companyName: companies[i], personName: 'Asha Rao', designation: 'Director', linkedinUrl: null, source: 'ZaubaCorp', status: 'no_linkedin' };
      rows.push(row);
      job.onRow(row);
      job.setProgress({ current: i + 1, completed: i + 1, company: null });
      // Wait to be cancelled rather than racing the test's HTTP request.
      await new Promise((resolve) => job.onCancel(resolve));
    }
    return rows;
  },
} };
const app = require('../server');

async function uploadTwoCompanies(origin, filename) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Companies');
  sheet.addRow(['Company Name']);
  sheet.addRow(['Acme Industries']);
  sheet.addRow(['Betabrand Foods']);
  const form = new FormData();
  form.append('excel', new Blob([await workbook.xlsx.writeBuffer()]), filename);
  form.append('searchProvider', 'searxng');
  form.append('searxngUrl', 'http://127.0.0.1:8080');
  const res = await fetch(`${origin}/api/upload`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  return (await res.json()).jobId;
}

async function waitForStatus(origin, jobId, wanted) {
  let state;
  for (let attempt = 0; attempt < 200; attempt++) {
    state = await (await fetch(`${origin}/api/status/${jobId}`)).json();
    if (wanted.includes(state.status)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`job never reached ${wanted.join('/')} (last: ${state && state.status})`);
}

test('cancelling a running job stops it and still produces a partial report', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const filename = `cancel-route-test-${process.pid}.xlsx`;
  const outputFiles = [];
  t.after(async () => {
    const uploads = path.join(__dirname, '..', 'uploads');
    for (const name of await fs.readdir(uploads)) {
      if (name.endsWith(`-${filename}`)) await fs.unlink(path.join(uploads, name));
    }
    for (const output of outputFiles) await fs.unlink(output).catch(() => {});
  });

  const jobId = await uploadTwoCompanies(origin, filename);
  outputFiles.push(path.join(__dirname, '..', 'outputs', `report-${jobId.slice(0, 8)}.xlsx`));

  const running = await waitForStatus(origin, jobId, ['running']);
  assert.equal(running.cancellable, true);
  assert.equal(running.cancelled, false);

  const cancel = await (await fetch(`${origin}/api/cancel/${jobId}`, { method: 'POST' })).json();
  assert.equal(cancel.ok, true);
  assert.equal(cancel.status, 'cancelling');

  const state = await waitForStatus(origin, jobId, ['cancelled', 'done', 'error']);
  assert.equal(state.status, 'cancelled', 'a cancelled run must not report itself as done');
  assert.equal(state.cancelled, true);
  assert.equal(state.cancellable, false);
  assert.equal(state.rows.length, 1, 'only the company processed before the cancel is kept');
  assert.ok(state.hasOutput, 'the partial results are still exported');
  assert.ok(state.logs.some((line) => line.includes('CANCEL requested')));
  assert.ok(state.logs.some((line) => line.includes('CANCELLED - partial report ready')));

  // The report exists, holds the partial rows, and says the run was cancelled.
  const download = await fetch(`${origin}/api/download/${jobId}`);
  assert.equal(download.status, 200);
  const report = new ExcelJS.Workbook();
  await report.xlsx.load(await download.arrayBuffer());
  assert.equal(report.getWorksheet('Directors Report').rowCount, 2, 'header + one company row');
  const summary = report.getWorksheet('Summary');
  const runStatus = summary.getRows(1, summary.rowCount)
    .find((row) => row.getCell(1).value === 'Run Status');
  assert.ok(runStatus, 'the Summary sheet must record the cancellation');
  assert.match(String(runStatus.getCell(2).value), /Cancelled by user after 1 of 2 companies/);

  // A finished job cannot be cancelled again, and the SSE replay closes.
  const again = await (await fetch(`${origin}/api/cancel/${jobId}`, { method: 'POST' })).json();
  assert.equal(again.ok, false);
  assert.equal(again.status, 'cancelled');
  const replay = await fetch(`${origin}/api/events/${jobId}`, { signal: AbortSignal.timeout(2000) });
  const events = (await replay.text()).trim().split('\n\n').map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map((event) => event.type), ['logs', 'rows', 'state']);
  assert.equal(events.at(-1).state.status, 'cancelled', 'a cancelled SSE replay must end after sending data');

  const missing = await fetch(`${origin}/api/cancel/does-not-exist`, { method: 'POST' });
  assert.equal(missing.status, 404);
});
