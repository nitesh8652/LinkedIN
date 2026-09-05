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
let searchProvider = 'serper';
let searchSettingsReady = false;
let settingsRevision = 0;
let serperConfigured = false;

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
  uploadBtn.disabled = !searchSettingsReady;
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
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading...';

  const fd = new FormData();
  fd.append('excel', selectedFile);

  try {
    if (searchProvider === 'searxng' && !searxngUrlInput.reportValidity()) {
      throw new Error('Enter a valid SearXNG instance URL');
    }
    fd.append('searchProvider', searchProvider);
    if (searchProvider === 'searxng') fd.append('searxngUrl', searxngUrlInput.value.trim());
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
    downloadBtn.classList.add('hidden');
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
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload & Start Processing';
  }
});

function stopJobUpdates() {
  jobFinished = true;
  if (eventSource) { eventSource.close(); eventSource = null; }
  clearTimeout(pollTimer);
  pollTimer = null;
  if (pollController) { pollController.abort(); pollController = null; }
}

function connectEvents(id) {
  stopJobUpdates();
  jobFinished = false;
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
  if (state.status === 'finalizing') progressText.textContent = 'All companies fetched. Preparing report...';
  if (state.status === 'done') {
    finishJob(null, state);
  } else if (state.status === 'error') {
    finishJob(state.error || 'Unknown server error', state);
  }
}

function finishJob(errMsg, state) {
  stopJobUpdates();
  currentCompanyBox.classList.add('hidden');

  if (errMsg) {
    errorBanner.textContent = `Processing failed: ${errMsg}`;
    errorBanner.classList.remove('hidden');
    doneBanner.classList.add('hidden');
    progressText.textContent = 'Failed.';
    return;
  }
  percentText.textContent = '100%';
  progressFill.style.width = '100%';
  doneBanner.classList.remove('hidden');
  errorBanner.classList.add('hidden');
  progressText.textContent = 'Complete!';
  if (state.hasOutput) {
    downloadBtn.href = `/api/download/${jobId}`;
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
  if (row.source === 'ZaubaCorp' && row.sourceUrl) {
    const sourceLink = document.createElement('a');
    sourceLink.href = row.sourceUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = row.source;
    sourceCell.replaceChildren(sourceLink);
  }
  tr.appendChild(sourceCell);
  tr.appendChild(makeCell(STATUS_LABELS[row.status] || row.status || ''));
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

function renderSearchSettings() {
  providerButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.provider === searchProvider));
  });
  const isSearxng = searchProvider === 'searxng';
  searxngSettings.classList.toggle('hidden', !isSearxng);
  searxngUrlInput.required = isSearxng;
  setSearchStatus(isSearxng
    ? 'Searches use your SearXNG instance. Test the connection before uploading.'
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
}));
searxngUrlInput.addEventListener('input', saveSearchSettings);

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
    if (!settingsRevision) {
      searchProvider = ['serper', 'searxng'].includes(saved?.provider) ? saved.provider : data.provider;
      searxngUrlInput.value = typeof saved?.searxngUrl === 'string' ? saved.searxngUrl : data.searxngUrl;
    }
    searchSettingsReady = true;
    checkSearchBtn.disabled = false;
    uploadBtn.disabled = !selectedFile;
    renderSearchSettings();
  } catch (err) {
    setSearchStatus(err.message, 'error');
  }
}

checkSearchBtn.addEventListener('click', async () => {
  if (searchProvider === 'searxng' && !searxngUrlInput.reportValidity()) return;
  const revision = settingsRevision;
  const provider = searchProvider;
  checkSearchBtn.disabled = true;
  setSearchStatus(`Testing ${provider === 'searxng' ? 'SearXNG' : 'Serper'}...`);
  try {
    const res = await fetch('/api/search-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, ...(provider === 'searxng' ? { searxngUrl: searxngUrlInput.value.trim() } : {}) }),
    });
    const data = await res.json();
    if (revision !== settingsRevision) return;
    if (!res.ok || !data.ok) throw new Error(data.error || 'Connection failed');
    const message = `${provider === 'searxng' ? 'SearXNG' : 'Serper'} connection is working${data.credits == null ? '' : ` (${data.credits} credits left)`}`;
    setSearchStatus(message, 'ok');
    showToast(message, true);
  } catch (err) {
    if (revision === settingsRevision) setSearchStatus(err.message, 'error');
  } finally {
    checkSearchBtn.disabled = false;
  }
});

loadSearchSettings();
