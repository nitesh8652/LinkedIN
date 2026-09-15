/* Frontend logic: upload -> SSE live progress -> results table -> download */

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileNameEl = document.getElementById('fileName');
const fileSizeEl = document.getElementById('fileSize');
const clearFileBtn = document.getElementById('clearFile');
const uploadBtn = document.getElementById('uploadBtn');

const statusCard = document.getElementById('statusCard');
const resultsCard = document.getElementById('resultsCard');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const percentText = document.getElementById('percentText');
const currentCompanyBox = document.getElementById('currentCompany');
const currentCompanyName = document.getElementById('currentCompanyName');
const logBox = document.getElementById('logBox');
const statCompanies = document.getElementById('statCompanies');
const statPeople = document.getElementById('statPeople');
const statLinkedin = document.getElementById('statLinkedin');
const doneBanner = document.getElementById('doneBanner');
const errorBanner = document.getElementById('errorBanner');
const cancelBanner = document.getElementById('cancelBanner');
const cancelBtn = document.getElementById('cancelBtn');
const cancelHint = document.getElementById('cancelHint');
const downloadBtn = document.getElementById('downloadBtn');
const resultsTableBody = document.querySelector('#resultsTable tbody');

let selectedFile = null;
let jobId = null;
let eventSource = null;
let pollTimer = null;
let pollController = null;
let jobFinished = true;
const providerButtons = [...document.querySelectorAll('[data-provider]')];
const searxngSettings = document.getElementById('searxngSettings');
const searxngUrlInput = document.getElementById('searxngUrl');
const searchStatus = document.getElementById('searchStatus');
const checkSearchBtn = document.getElementById('checkSearchBtn');
const linkedinSettings = document.getElementById('linkedinSettings');
const connectLinkedinBtn = document.getElementById('connectLinkedinBtn');
let searchProvider = 'linkedin';
let searchSettingsReady = false;
let settingsRevision = 0;
let serperConfigured = false;
let serpapiConfigured = false;
let linkedinConnection = null;
let linkedinConnecting = false;
let searchChecking = false;
let uploading = false;
const providerNames = { linkedin: 'LinkedIn Direct', own: 'Own Search', serper: 'Serper', serpapi: 'SerpApi', searxng: 'SearXNG', hybrid: 'SerpApi + SearXNG' };
const usesSearxng = () => ['own', 'searxng', 'hybrid'].includes(searchProvider);

// ---------- File selection ----------
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});
fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

['dragover', 'dragenter'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  })
);
dropZone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  setFile(f);
});

function setFile(f) {
  if (!f) return;
  if (!/\.(xlsx|xlsm)$/i.test(f.name)) {
    alert('Please select a valid .xlsx Excel file.');
    return;
  }
  selectedFile = f;
  fileNameEl.textContent = f.name;
  fileSizeEl.textContent = formatSize(f.size);
  fileInfo.classList.remove('hidden');
  updateSearchControls();
}

clearFileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  resetUpload();
});

function resetUpload() {
  selectedFile = null;
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  uploadBtn.disabled = true;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------- Upload & process ----------
uploadBtn.addEventListener('click', async () => {
  if (!selectedFile || uploadBtn.disabled) return;
  uploading = true;
  updateSearchControls();
  uploadBtn.textContent = 'Uploading...';

  const fd = new FormData();
  fd.append('excel', selectedFile);

  try {
    if (usesSearxng() && !searxngUrlInput.reportValidity()) {
      throw new Error('Enter a valid SearXNG instance URL');
    }
    fd.append('searchProvider', searchProvider);
    if (usesSearxng()) fd.append('searxngUrl', searxngUrlInput.value.trim());
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    stopJobUpdates();
    jobId = data.jobId;
    statCompanies.textContent = data.companiesFound;
    statusCard.classList.remove('hidden');
    resultsCard.classList.remove('hidden');
    doneBanner.classList.add('hidden');
    errorBanner.classList.add('hidden');
    cancelBanner.classList.add('hidden');
    downloadBtn.classList.add('hidden');
    showCancel(true);
    logBox.innerHTML = '';
    resultsTableBody.innerHTML = '';
    statPeople.textContent = '0';
    statLinkedin.textContent = '0';
    statLinkedin.dataset.count = '0';
    updateProgress({ current: 0, completed: 0, total: data.companiesFound, company: null });

    appendLog(`Uploaded "${data.companies.length > 0 ? data.companiesFound : 0}" companies. Agent started...`);
    connectEvents(jobId);
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    uploading = false;
    updateSearchControls();
    uploadBtn.textContent = 'Upload & Start Processing';
  }
});

// ---------- Cancel ----------
function showCancel(visible, { pending = false } = {}) {
  cancelBtn.classList.toggle('hidden', !visible);
  cancelHint.classList.toggle('hidden', !visible);
  cancelBtn.disabled = pending;
  cancelBtn.textContent = pending ? 'Cancelling...' : 'Cancel Processing';
}

cancelBtn.addEventListener('click', async () => {
  if (!jobId || cancelBtn.disabled) return;
  const id = jobId;
  showCancel(true, { pending: true });
  try {
    const res = await fetch(`/api/cancel/${id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not cancel the run');
    if (id !== jobId) return;
    appendLog(`[client] ${data.message}`);
    showToast(data.message, data.ok);
    // A job that already finished leaves nothing to cancel; its terminal
    // state event hides the button on its own.
    if (!data.ok) showCancel(false);
  } catch (err) {
    if (id !== jobId) return;
    showCancel(true);
    showToast(`Cancel failed: ${err.message}`, false);
  }
});

function stopJobUpdates() {
  jobFinished = true;
  if (eventSource) { eventSource.close(); eventSource = null; }
  clearTimeout(pollTimer);
  pollTimer = null;
  if (pollController) { pollController.abort(); pollController = null; }
  updateSearchControls();
}

function connectEvents(id) {
  stopJobUpdates();
  jobFinished = false;
  updateSearchControls();
  const source = new EventSource(`/api/events/${id}`);
  eventSource = source;

  source.onmessage = (e) => {
    if (jobFinished || id !== jobId || eventSource !== source) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case 'state':
        handleState(msg.state);
        break;
      case 'logs':
        msg.lines.forEach(appendLog);
        scrollLog();
        break;
      case 'log':
        appendLog(msg.line);
        break;
      case 'progress':
        updateProgress(msg.progress);
        break;
      case 'row':
        addResultRow(msg.row);
        break;
      case 'rows':
        msg.rows.forEach(addResultRow);
        break;
    }
  };

  source.onerror = () => {
    if (jobFinished || id !== jobId || eventSource !== source) return;
    // Close SSE so automatic reconnects cannot replay rows while we poll.
    source.close();
    eventSource = null;
    schedulePoll(id);
  };
}

function schedulePoll(id) {
  if (jobFinished || id !== jobId || pollTimer !== null) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    pollStatus(id);
  }, 2000);
}

async function pollStatus(id) {
  if (jobFinished || id !== jobId || pollController) return;
  const controller = new AbortController();
  pollController = controller;
  try {
    const res = await fetch(`/api/status/${id}`, { signal: controller.signal });
    if (jobFinished || id !== jobId) return;
    if (res.status === 404) {
      finishJob('Job not found. Start a new upload.', {});
      return;
    }
    if (res.ok) {
      const data = await res.json();
      if (jobFinished || id !== jobId) return;
      // Status contains a full snapshot, not new entries to append.
      logBox.innerHTML = '';
      resultsTableBody.innerHTML = '';
      statPeople.textContent = '0';
      statLinkedin.textContent = '0';
      statLinkedin.dataset.count = '0';
      (data.logs || []).forEach(appendLog);
      (data.rows || []).forEach(addResultRow);
      handleState(data);
    }
  } catch { /* keep trying silently */ }
  finally {
    if (pollController === controller) pollController = null;
    schedulePoll(id);
  }
}

function handleState(state) {
  if (state.progress) updateProgress(state.progress);
  if (state.meta?.searchProvider) {
    document.getElementById('jobSearchProvider').textContent = `Search: ${state.meta.searchProvider}`;
  }
  if (state.status === 'running') {
    progressText.textContent = state.rowsCount > 0
      ? `Processing companies... (${state.rowsCount} result rows so far)`
      : 'Processing companies...';
  }
  if (state.status === 'cancelling') {
    progressText.textContent = 'Cancelling... finishing the company in progress.';
    showCancel(true, { pending: true });
  }
  if (state.status === 'finalizing') {
    progressText.textContent = state.cancelled
      ? 'Cancelled. Preparing a report of the results so far...'
      : 'All companies fetched. Preparing report...';
  }
  if (state.status === 'done' || state.status === 'cancelled') {
    finishJob(null, state);
  } else if (state.status === 'error') {
    finishJob(state.error || 'Unknown server error', state);
  }
}

function finishJob(errMsg, state) {
  stopJobUpdates();
  currentCompanyBox.classList.add('hidden');
  showCancel(false);

  if (errMsg) {
    errorBanner.textContent = `Processing failed: ${errMsg}`;
    errorBanner.classList.remove('hidden');
    doneBanner.classList.add('hidden');
    cancelBanner.classList.add('hidden');
    progressText.textContent = 'Failed.';
    return;
  }
  const cancelled = state.status === 'cancelled';
  if (cancelled) {
    const rows = state.rowsCount || 0;
    cancelBanner.textContent = `Processing cancelled. ${rows} result row(s) were collected${state.hasOutput ? ' and are ready to download' : ''}.`;
    cancelBanner.classList.remove('hidden');
    doneBanner.classList.add('hidden');
    progressText.textContent = 'Cancelled.';
  } else {
    percentText.textContent = '100%';
    progressFill.style.width = '100%';
    doneBanner.classList.remove('hidden');
    cancelBanner.classList.add('hidden');
    progressText.textContent = 'Complete!';
  }
  errorBanner.classList.add('hidden');
  if (state.hasOutput) {
    downloadBtn.href = `/api/download/${jobId}`;
    downloadBtn.textContent = cancelled ? '⬇  Download Partial Report' : '⬇  Download Excel Report';
    downloadBtn.classList.remove('hidden');
  }
}

function updateProgress(progress) {
  const { current, total, company, completed = Math.max(0, current - 1) } = progress;
  if (total > 0) {
    const pct = Math.min(99, Math.round((completed / total) * 100));
    progressFill.style.width = `${pct}%`;
    percentText.textContent = `${pct}%`;
    progressText.textContent = `Company ${current} of ${total}`;
  }
  if (company && current <= total) {
    currentCompanyBox.classList.remove('hidden');
    currentCompanyName.textContent = `Researching: ${company}`;
  } else {
    currentCompanyBox.classList.add('hidden');
  }
}

// ---------- Results table ----------
const NULL_VALUE = 'NULL';

// Mirrors STATUS_LABELS in src/excel.js — why a row came back the way it did.
const STATUS_LABELS = {
  ok: 'Found',
  ok_medium: 'Found (medium confidence)',
  no_linkedin: 'No LinkedIn match',
  search_unavailable: 'Search temporarily unavailable',
  no_directors: 'Website found, no directors named',
  no_website: 'Official website not found',
  error: 'Error during research',
  // ZaubaCorp fallback — every way it can come up empty gets its own label.
  linkedin_unverified: 'LinkedIn verification failed',
  zauba_not_found: 'ZaubaCorp page not found',
  zauba_low_confidence: 'ZaubaCorp company match confidence too low',
  zauba_no_directors: 'ZaubaCorp directors unavailable',
  zauba_unreachable: 'ZaubaCorp page could not be loaded',
  zauba_error: 'ZaubaCorp lookup error',
};

const DEFAULT_SOURCE = 'Official Website';

function addResultRow(row) {
  const tr = document.createElement('tr');
  tr.appendChild(makeCell(row.companyName));
  tr.appendChild(makeCell(row.personName));

  const desigTd = makeCell(row.designation);
  tr.appendChild(desigTd);

  const td = document.createElement('td');
  const url = row.linkedinUrl;
  if (url && url !== NULL_VALUE) {
    statLinkedin.dataset.count = (parseInt(statLinkedin.dataset.count || 0, 10) + 1).toString();
    statLinkedin.textContent = statLinkedin.dataset.count;
    const a = document.createElement('a');
    a.href = normalizeLinkedInUrl(url);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = shortenUrl(url);
    td.appendChild(a);
  } else {
    td.textContent = NULL_VALUE;
    td.className = 'null';
  }
  tr.appendChild(td);
  const sourceCell = makeCell(row.source || DEFAULT_SOURCE);
  if (row.source?.startsWith('ZaubaCorp') && row.sourceUrl) {
    const sourceLink = document.createElement('a');
    sourceLink.href = row.sourceUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = row.source;
    sourceCell.replaceChildren(sourceLink);
  }
  tr.appendChild(sourceCell);
  const statusCell = makeCell(STATUS_LABELS[row.status] || row.status || '');
  if (row.reason) {
    statusCell.title = row.reason;
    const detail = document.createElement('small');
    detail.className = 'status-detail';
    detail.textContent = row.reason;
    statusCell.appendChild(detail);
  }
  tr.appendChild(statusCell);
  tr.appendChild(makeCell(row.din));
  tr.appendChild(makeCell(row.appointmentDate));

  resultsTableBody.appendChild(tr);

  // people count = rows with a person name
  const peopleRows = [...resultsTableBody.querySelectorAll('tr')].filter(
    (r) => r.children[1].textContent !== NULL_VALUE
  ).length;
  statPeople.textContent = peopleRows;
}

function makeCell(value) {
  const td = document.createElement('td');
  if (!value || value === NULL_VALUE) {
    td.textContent = NULL_VALUE;
    td.className = 'null';
  } else {
    td.textContent = value;
  }
  return td;
}

function normalizeLinkedInUrl(url) {
  return url.startsWith('http') ? url : `https://${url}`;
}

function shortenUrl(url) {
  return url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48);
}

// ---------- Log helpers ----------
function appendLog(line) {
  const el = document.createElement('div');
  el.textContent = line;
  logBox.appendChild(el);
  while (logBox.childElementCount > 400) logBox.removeChild(logBox.firstChild);
  scrollLog();
}

function scrollLog() {
  logBox.scrollTop = logBox.scrollHeight;
}

// ---------- Search connection status ----------
let activeToast = null;

function showToast(text, ok) {
  if (typeof Toastify !== 'function') {
    console[ok ? 'log' : 'warn'](text);
    return;
  }
  // Never stack: drop whatever is on screen before showing the new one.
  if (activeToast) {
    try { activeToast.hideToast(); } catch { /* already gone */ }
  }
  activeToast = Toastify({
    text,
    duration: ok ? 5000 : 8000,
    close: true,
    gravity: 'top',
    position: 'right',
    stopOnFocus: true,
    style: {
      background: ok
        ? 'linear-gradient(to right, #16a34a, #22c55e)'
        : 'linear-gradient(to right, #dc2626, #ef4444)',
    },
  });
  activeToast.showToast();
}

function setSearchStatus(message, state = '') {
  searchStatus.textContent = message;
  searchStatus.dataset.state = state;
}

function updateSearchControls() {
  const isLinkedin = searchProvider === 'linkedin';
  checkSearchBtn.disabled = !searchSettingsReady || searchChecking || linkedinConnecting || (isLinkedin && (!jobFinished || uploading));
  connectLinkedinBtn.disabled = !searchSettingsReady || linkedinConnecting || searchChecking || !jobFinished || uploading;
  uploadBtn.disabled = !selectedFile || !searchSettingsReady || uploading || !jobFinished ||
    (isLinkedin && (!linkedinConnection?.connected || linkedinConnecting || searchChecking));
}

function renderSearchSettings() {
  providerButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.provider === searchProvider));
  });
  const isSearxng = searchProvider === 'searxng';
  linkedinSettings.classList.toggle('hidden', searchProvider !== 'linkedin');
  searxngSettings.classList.toggle('hidden', !usesSearxng());
  searxngUrlInput.required = usesSearxng();
  updateSearchControls();
  if (searchProvider === 'linkedin') {
    setSearchStatus(linkedinConnection?.message || 'Connect LinkedIn and sign in, then test the connection. Searches run directly on LinkedIn with no paid credits.',
      linkedinConnection?.connected ? 'ok' : '');
    return;
  }
  if (searchProvider === 'own') {
    setSearchStatus('Your search API combines SearXNG with direct web searches. No paid search key needed. LinkedIn matches require the same person and company.');
    return;
  }
  if (searchProvider === 'hybrid') {
    setSearchStatus('Searches both providers in parallel and uses the first relevant results. If one fails, the other continues. Uses SerpApi credits.' +
      (serpapiConfigured ? '' : ' SerpApi key missing; only SearXNG can respond.'));
    return;
  }
  setSearchStatus(isSearxng
    ? 'Searches use your SearXNG instance. Test the connection before uploading.'
    : searchProvider === 'serpapi'
      ? serpapiConfigured
        ? 'SerpApi key configured. Uses Google to find directors and LinkedIn profiles, with ZaubaCorp as a fallback. Searches and connection tests use API credits.'
        : 'No SerpApi key configured. Set SERPAPI_API_KEY in .env and restart the server.'
    : serperConfigured
      ? 'Serper key configured. Searches and connection tests use API credits.'
      : 'No Serper key configured. Searches will use scraped fallback engines.');
}

function saveSearchSettings() {
  settingsRevision++;
  try {
    localStorage.setItem('research-search-settings', JSON.stringify({
      provider: searchProvider, searxngUrl: searxngUrlInput.value.trim(),
    }));
  } catch { /* settings still work when browser storage is disabled */ }
  renderSearchSettings();
}

providerButtons.forEach((button) => button.addEventListener('click', () => {
  searchProvider = button.dataset.provider;
  saveSearchSettings();
  if (searchProvider === 'linkedin' && jobFinished && !linkedinConnecting && !searchChecking) refreshLinkedInStatus();
}));
searxngUrlInput.addEventListener('input', saveSearchSettings);

async function refreshLinkedInStatus() {
  try {
    const res = await fetch('/api/linkedin/status');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not read the LinkedIn connection');
    linkedinConnection = data;
  } catch (err) {
    linkedinConnection = { connected: false, message: err.message };
  }
  if (searchProvider === 'linkedin') renderSearchSettings();
}

connectLinkedinBtn.addEventListener('click', async () => {
  if (connectLinkedinBtn.disabled) return;
  linkedinConnecting = true;
  updateSearchControls();
  connectLinkedinBtn.textContent = 'Opening LinkedIn...';
  setSearchStatus('Opening LinkedIn on this computer. Sign in in the browser window.');
  try {
    const res = await fetch('/api/linkedin/connect', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not open LinkedIn');
    linkedinConnection = data;
    if (searchProvider === 'linkedin') renderSearchSettings();
  } catch (err) {
    linkedinConnection = { connected: false, message: err.message };
    if (searchProvider === 'linkedin') setSearchStatus(err.message, 'error');
  } finally {
    linkedinConnecting = false;
    connectLinkedinBtn.textContent = 'Connect LinkedIn';
    updateSearchControls();
  }
});

async function loadSearchSettings() {
  try {
    const res = await fetch('/api/search-config');
    if (!res.headers.get('content-type')?.includes('application/json')) {
      throw new Error('Restart the server to load the search provider settings');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load search settings');
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('research-search-settings')); } catch { /* use server defaults */ }
    serperConfigured = data.serper.configured;
    serpapiConfigured = Boolean(data.serpapi?.configured);
    if (!settingsRevision) {
      searchProvider = Object.hasOwn(providerNames, saved?.provider) ? saved.provider : 'linkedin';
      searxngUrlInput.value = typeof saved?.searxngUrl === 'string' ? saved.searxngUrl : data.searxngUrl || 'http://localhost:8080';
    }
    searchSettingsReady = true;
    renderSearchSettings();
    if (searchProvider === 'linkedin') await refreshLinkedInStatus();
  } catch (err) {
    setSearchStatus(err.message, 'error');
  }
}

checkSearchBtn.addEventListener('click', async () => {
  if (checkSearchBtn.disabled) return;
  if (usesSearxng() && !searxngUrlInput.reportValidity()) return;
  const revision = settingsRevision;
  const provider = searchProvider;
  searchChecking = true;
  updateSearchControls();
  setSearchStatus(`Testing ${providerNames[provider]}...`);
  try {
    const res = await fetch('/api/search-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, ...(['own', 'searxng', 'hybrid'].includes(provider) ? { searxngUrl: searxngUrlInput.value.trim() } : {}) }),
    });
    const data = await res.json();
    if (provider === 'linkedin') linkedinConnection = { ...data, connected: Boolean(data.connected ?? data.ok) };
    if (revision !== settingsRevision) return;
    if (!res.ok || !data.ok) throw new Error(data.error || data.message || 'Connection failed');
    const warnings = data.warnings || [];
    const message = provider === 'linkedin'
      ? data.message || 'LinkedIn is connected. Ready to search without paid credits.'
      : warnings.length
      ? `${providerNames[provider]} connected with limited engines (${warnings.join('; ')})`
      : data.respondingProvider
        ? `${providerNames[provider]} ready: ${data.respondingProvider} responded first`
        : `${providerNames[provider]} connection is working${data.credits == null ? '' : ` (${data.credits} credits left)`}`;
    setSearchStatus(message, warnings.length ? 'warning' : 'ok');
    showToast(message, true);
  } catch (err) {
    if (provider === 'linkedin') linkedinConnection = { connected: false, message: err.message };
    if (revision === settingsRevision) setSearchStatus(err.message, 'error');
  } finally {
    searchChecking = false;
    updateSearchControls();
  }
});

loadSearchSettings();
