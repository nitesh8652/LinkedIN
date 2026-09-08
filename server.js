/**
 * Express server: upload Excel -> background agent run with live progress
 * (SSE + polling) -> download generated report.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const { readCompaniesFromExcel, writeResultsToExcel } = require('./src/excel');
const { runAgent } = require('./src/agent');
const { verifySearchProvider, serperStatus } = require('./src/search');
const { resolveSearchConfig, withSearchConfig } = require('./src/search-config');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xlsm)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx files are supported'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** In-memory job store. */
const jobs = new Map();

function createJob(jobId) {
  const job = {
    id: jobId,
    // queued | running | cancelling | finalizing | done | error | cancelled
    status: 'queued',
    logs: [],
    rows: [],
    progress: { current: 0, completed: 0, total: 0, company: null },
    meta: {},
    error: null,
    outputPath: null,
    createdAt: Date.now(),
    listeners: new Set(),
    // Cancellation is cooperative: the flag is set here and the agent stops at
    // its next clean boundary, so the rows already collected still make it
    // into a report.
    cancelled: false,
    cancelWaiters: new Set(),
    log(msg) {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
      this.logs.push(line);
      if (this.logs.length > 2000) this.logs.shift();
      this.broadcast({ type: 'log', line });
    },
    setMeta(meta) {
      Object.assign(this.meta, meta);
      if (meta.total) this.progress.total = meta.total;
      this.broadcast({ type: 'state', state: this.snapshot() });
    },
    setProgress(p) {
      Object.assign(this.progress, p);
      this.broadcast({ type: 'progress', progress: this.progress });
    },
    onRow(row) {
      this.rows.push(row);
      this.broadcast({ type: 'row', row });
    },
    /** Ask the run to stop. Returns false once the job can no longer be stopped. */
    cancel() {
      if (this.cancelled) return false;
      if (['done', 'error', 'cancelled'].includes(this.status)) return false;
      this.cancelled = true;
      this.status = 'cancelling';
      this.log('CANCEL requested - finishing the current company, then stopping');
      for (const waiter of this.cancelWaiters) {
        try { waiter(); } catch { /* a waiter that already resolved */ }
      }
      this.cancelWaiters.clear();
      this.broadcast({ type: 'state', state: this.snapshot() });
      return true;
    },
    /**
     * Let the agent shorten a wait it is already sitting in. Returns a
     * disposer so a wait that ends normally unregisters itself.
     */
    onCancel(fn) {
      if (this.cancelled) {
        fn();
        return null;
      }
      this.cancelWaiters.add(fn);
      return () => this.cancelWaiters.delete(fn);
    },
    broadcast(event) {
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of this.listeners) {
        try { res.write(payload); } catch { /* dead listener */ }
      }
    },
    closeListeners() {
      for (const res of this.listeners) res.end();
      this.listeners.clear();
    },
    snapshot() {
      return {
        id: this.id,
        status: this.status,
        progress: this.progress,
        rowsCount: this.rows.length,
        meta: this.meta,
        error: this.error,
        hasOutput: Boolean(this.outputPath),
        cancelled: this.cancelled,
        cancellable: !['done', 'error', 'cancelled'].includes(this.status) && !this.cancelled,
      };
    },
  };
  jobs.set(jobId, job);
  return job;
}

// ---------- Routes ----------

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/upload', upload.single('excel'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const searchOptions = resolveSearchConfig({
      provider: req.body.searchProvider,
      searxngUrl: req.body.searxngUrl,
    });

    const companies = await readCompaniesFromExcel(req.file.path).catch((err) => {
      throw new Error(`Invalid Excel file: ${err.message}`);
    });

    const jobId = uuidv4();
    const job = createJob(jobId);
    job.progress.total = companies.length;
    job.log(`Parsed ${companies.length} companies from uploaded file`);

    // Run the agent in the background
    job.status = 'running';
    (async () => {
      try {
        const rows = await runAgent(companies, job, searchOptions);
        job.status = 'finalizing';
        job.broadcast({ type: 'state', state: job.snapshot() });
        const outName = `report-${jobId.slice(0, 8)}.xlsx`;
        const outPath = path.join(OUTPUT_DIR, outName);
        await writeResultsToExcel(rows, outPath, {
          totalCompanies: companies.length,
          llmEnabled: job.meta.llmEnabled,
          // runAgent already worked out which backend actually served the
          // run; without passing it through, the Summary sheet claimed
          // "scraped engines" even on a healthy Serper key.
          searchProvider: job.meta.searchProvider,
          // A cancelled run still gets a report; the sheet says so rather
          // than passing partial results off as a complete list.
          cancelled: job.cancelled,
          companiesProcessed: job.progress.completed,
        });
        job.outputPath = `/api/download/${jobId}`;
        job.outputFile = outPath;
        job.status = job.cancelled ? 'cancelled' : 'done';
        job.log(job.cancelled
          ? `CANCELLED - partial report ready (${rows.length} row(s) from ${job.progress.completed} company/companies)`
          : 'DONE - report ready for download');
      } catch (err) {
        console.error(err);
        job.status = 'error';
        job.error = err.message;
        job.log(`FATAL: ${err.message}`);
      }
      job.broadcast({ type: 'state', state: job.snapshot() });
      job.closeListeners();
    })();

    res.json({ jobId, companiesFound: companies.length, companies: companies.slice(0, 50) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Configuration reads never spend search credits. Connection tests are explicit.
app.get('/api/search-config', (req, res) => {
  try {
    res.json({ ...resolveSearchConfig(), serper: serperStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/search-check', async (req, res) => {
  let config;
  try { config = resolveSearchConfig(req.body); } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  const result = await withSearchConfig(config, () => verifySearchProvider());
  res.json({ provider: config.provider, ...result });
});

app.get('/api/serper-check', (req, res) => {
  // Older tabs called this automatically, spending Serper credits even
  // during SearXNG jobs. Only the explicit provider-aware POST may probe.
  res.json({ ...serperStatus(), ok: null, skipped: true, message: 'Use POST /api/search-check to test the selected provider' });
});

app.post('/api/cancel/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const cancelled = job.cancel();
  res.json({
    ok: cancelled,
    status: job.status,
    message: cancelled
      ? 'Stopping after the company currently being researched'
      : `Job already ${job.status}`,
  });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    ...job.snapshot(),
    rows: job.rows,
    logs: job.logs.slice(-200),
  });
});

app.get('/api/events/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Replay data before a terminal state tells the client to close its stream.
  res.write(`data: ${JSON.stringify({ type: 'logs', lines: job.logs })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'rows', rows: job.rows })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'state', state: job.snapshot() })}\n\n`);
  if (['done', 'error', 'cancelled'].includes(job.status)) return res.end();
  job.listeners.add(res);
  req.on('close', () => job.listeners.delete(res));
});

app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.outputFile || !fs.existsSync(job.outputFile)) {
    return res.status(404).json({ error: 'Report not available yet' });
  }
  res.download(job.outputFile, `Company-Directors-Report-${jobIdShort(req.params.jobId)}.xlsx`);
});

function jobIdShort(id) {
  return id.slice(0, 8);
}

app.use((err, req, res, next) => {
  if (err.message && err.message.includes('xlsx')) {                
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI Company Research Agent running at http://localhost:${PORT}`);
  });
}

module.exports = app;
