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
  uploadBtn.disabled = false;
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
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    jobId = data.jobId;
    statCompanies.textContent = data.companiesFound;
    statusCard.classList.remove('hidden');
    resultsCard.classList.remove('hidden');
    doneBanner.classList.add('hidden');
    errorBanner.classList.add('hidden');
    downloadBtn.classList.add('hidden');
    logBox.innerHTML = '';
    resultsTableBody.innerHTML = '';

    appendLog(`Uploaded "${data.companies.length > 0 ? data.companiesFound : 0}" companies. Agent started...`);
    connectEvents(jobId);
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload & Start Processing';
  }
});

function connectEvents(id) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/events/${id}`);

  eventSource.onmessage = (e) => {
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

  eventSource.onerror = () => {
    // fall back to polling in case SSE drops
    setTimeout(() => pollStatus(id), 2000);
  };
}

async function pollStatus(id) {
  try {
    const res = await fetch(`/api/status/${id}`);
    if (res.ok) {
      const data = await res.json();
      data.logs.forEach(appendLog);
      data.rows.forEach(addResultRow);
      updateProgress(data.progress);
      handleState(data);
    }
  } catch { /* keep trying silently */ }
}

function handleState(state) {
  if (state.status === 'running') {
    progressText.textContent = state.rowsCount > 0
      ? `Processing companies... (${state.rowsCount} result rows so far)`
      : 'Processing companies...';
  }
  if (state.status === 'done') {
    finishJob(null, state);
  } else if (state.status === 'error') {
    finishJob(state.error || 'Unknown server error', state);
  }
}

function finishJob(errMsg, state) {
  if (eventSource) { eventSource.close(); eventSource = null; }
  currentCompanyBox.classList.add('hidden');
  percentText.textContent = '100%';
  progressFill.style.width = '100%';

  if (errMsg) {
    errorBanner.textContent = `Processing failed: ${errMsg}`;
    errorBanner.classList.remove('hidden');
    doneBanner.classList.add('hidden');
    progressText.textContent = 'Failed.';
    return;
  }
  doneBanner.classList.remove('hidden');
  errorBanner.classList.add('hidden');
  progressText.textContent = 'Complete!';
  if (state.hasOutput) {
    downloadBtn.href = `/api/download/${jobId}`;
    downloadBtn.classList.remove('hidden');
  }
}

function updateProgress(progress) {
  const { current, total, company } = progress;
  if (total > 0) {
    const pct = Math.min(100, Math.round((current / total) * 100));
    progressFill.style.width = `${pct}%`;
    percentText.textContent = `${pct}%`;
    progressText.textContent = `Company ${current} of ${total}`;
  }
  if (company && current <= total) {
    currentCompanyBox.classList.remove('hidden');
    currentCompanyName.textContent = `Researching: ${company}`;
  } else if (current > total) {
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
  tr.appendChild(makeCell(row.source || DEFAULT_SOURCE));
  tr.appendChild(makeCell(STATUS_LABELS[row.status] || row.status || ''));

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

// ---------- Serper API key status toast ----------
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

let serperChecked = false;

async function checkSerperKey() {
  if (serperChecked) return; // guard against a double invocation
  serperChecked = true;
  try {
    const res = await fetch('/api/serper-check', {
      headers: { Accept: 'application/json' },
    });

    // A stale server without this route answers with an HTML 404 page, which
    // blows up res.json() with "Unexpected token '<'". Detect that and say
    // something useful instead.
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      showToast(
        '⚠️ Serper check endpoint not found — restart the server to pick up /api/serper-check',
        false
      );
      return;
    }

    const data = await res.json();
    if (data.ok) {
      const credits = data.credits != null ? ` — ${data.credits} credits left` : '';
      showToast(`✅ Serper API key is working${credits}`, true);
    } else if (data.configured) {
      showToast(`❌ Serper API key not working: ${data.error || 'rejected'}`, false);
    } else {
      showToast('⚠️ No Serper API key configured — falling back to scraped engines', false);
    }
  } catch (err) {
    showToast(`❌ Could not verify Serper API key: ${err.message}`, false);
  }
}

checkSerperKey();
