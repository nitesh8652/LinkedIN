/** Direct, signed-in LinkedIn people search. No external search API is used. */
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { brandTokens, companySearchName } = require('./normalize');
const { cleanName, isValidPersonName, findDesignations, normalizeDesignation } = require('./person');

const PROFILE_DIR = path.join(__dirname, '..', '.linkedin-profile');
// The current LinkedIn UI uses generated class names; its result list keeps
// semantic roles inside the workspace's lazy column.
const WORKSPACE_CARD_SELECTOR = 'main#workspace [data-testid="lazy-column"] [role="list"] [role="listitem"]';
const CARD_SELECTOR = [
  '.reusable-search__result-container', '.entity-result',
  '[data-view-name="people-search-result"]',
  '[data-chameleon-result-urn^="urn:li:member:"]',
  '[data-chameleon-result-urn^="urn:li:fsd_profile:"]',
  'li.search-result__occluded-item',
  WORKSPACE_CARD_SELECTOR,
].join(', ');
const SEARCH_TIMEOUT_MS = 90000;
const NAVIGATION_TIMEOUT_MS = 20000;
const RESULTS_TIMEOUT_MS = 10000;
const SEARCH_INTERVAL_MS = 2500;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

function unavailable(message, status = 'unavailable') {
  const error = new Error(`Direct LinkedIn search unavailable: ${message}`);
  error.code = 'SEARCH_UNAVAILABLE';
  error.directSearch = true;
  error.status = status;
  return error;
}

function abortError() {
  const error = new Error('LinkedIn search cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function abortable(promise, signal, onAbort = () => {}) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    if (signal.aborted) { abort(); Promise.resolve(promise).catch(() => {}); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function linkedInHost(host) {
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

function canonicalProfileUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, 'https://www.linkedin.com');
    if (!['http:', 'https:'].includes(url.protocol) || !linkedInHost(url.hostname) || url.username || url.password || url.port) return '';
    const match = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
    if (!match || /[\\/\s?#]/.test(decodeURIComponent(match[1]))) return '';
    return `https://www.linkedin.com/in/${match[1]}`;
  } catch { return ''; }
}

function flat(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }

/** Preserve separate evidence lines while dropping accessibility duplicates/UI. */
function evidenceText($, selection) {
  const copy = selection.clone();
  copy.find('script, style, button, svg, .visually-hidden, .sr-only, [hidden], .entity-result__badge, .entity-result__insights').remove();
  copy.find('br').replaceWith('\n');
  copy.find('p, div, li, h1, h2, h3, h4').each((_, node) => {
    $(node).prepend('\n').append('\n');
  });
  return [...new Set(copy.text().split(/[\r\n]+/).map(flat).filter(Boolean))].join('\n');
}

/**
 * Parse only individual result cards. In particular, neither the query nor the
 * page's search input, header, or a neighbouring card supplies employer evidence.
 * The status distinguishes a genuine empty result from login or changed markup.
 */
function parseLinkedInPeopleHtml(html, pageUrl = 'https://www.linkedin.com/search/results/people/', httpStatus = 200) {
  const $ = cheerio.load(String(html || ''));
  let url;
  try { url = new URL(pageUrl); } catch { return { status: 'unexpected', results: [] }; }
  if (!linkedInHost(url.hostname) || !['https:', 'http:'].includes(url.protocol)) return { status: 'unexpected', results: [] };
  const text = flat($('body').text());
  if (httpStatus === 429 || /(?:weekly|commercial use|search) limit|too many requests|you.ve reached.*(?:limit|search)|unusual activity.*account/i.test(text)) {
    return { status: 'rate_limited', results: [] };
  }
  if (/\/checkpoint(?:\/|$)|\/challenge(?:\/|$)/i.test(url.pathname) || $('#captcha-internal, iframe[src*="captcha"], input[name="pin"], [data-test-id="challenge"]').length || /(?:security verification|verify your identity|let.s do a quick security check|your account has been.*restricted)/i.test(text)) {
    return { status: 'verification_required', results: [] };
  }
  if (httpStatus === 401 || /\/(?:login|uas\/login|authwall|signup)(?:\/|$)/i.test(url.pathname) || $('#username, input[name="session_key"], form[action*="login-submit"]').length) {
    return { status: 'not_connected', results: [] };
  }
  if (httpStatus >= 400) return { status: 'unavailable', results: [] };
  if (!/^\/search\/results\/people\/?$/.test(url.pathname)) return { status: 'unexpected', results: [] };

  const cards = $(CARD_SELECTOR).filter((_, card) => $(card).parents(CARD_SELECTOR).length === 0);
  const results = [];
  const seen = new Set();
  let recognizableCards = 0;
  cards.each((_, card) => {
    const root = $(card);
    const links = root.find('a[href]');
    const workspaceCard = root.is(WORKSPACE_CARD_SELECTOR);
    if (/linkedin\s+member/i.test(root.text())) recognizableCards++;
    let profileLink;
    // Prefer the name link over the profile photograph link.
    const titleLink = workspaceCard
      ? root.find('p a[href]').filter((_, link) => canonicalProfileUrl($(link).attr('href')) && flat(evidenceText($, $(link)))).first()
      : root.find('.entity-result__title-text a[href], [data-view-name="search-result-lockup-title"] a[href], a[data-view-name="search-result-lockup-title"]').first();
    if (titleLink.length && canonicalProfileUrl(titleLink.attr('href'))) profileLink = titleLink;
    if (!profileLink && !workspaceCard) links.each((_, link) => {
      if (profileLink || !canonicalProfileUrl($(link).attr('href'))) return;
      if (flat(evidenceText($, $(link)))) profileLink = $(link);
    });
    if (!profileLink) return;
    const url = canonicalProfileUrl(profileLink.attr('href'));
    let evidenceRoot = root;
    if (workspaceCard) {
      // Empty overlay/photo anchors precede the visible name in this layout.
      // A later mutual-contact link cannot stand in for the card's person.
      const target = links.toArray().map((link) => canonicalProfileUrl($(link).attr('href'))).find(Boolean);
      if (target !== url) return;
      evidenceRoot = profileLink.closest('p').parent();
      if (evidenceRoot.find('a[href]').toArray().some((link) => {
        const linkedProfile = canonicalProfileUrl($(link).attr('href'));
        return linkedProfile && linkedProfile !== url;
      })) return;
    }
    const visibleName = profileLink.find('span[aria-hidden="true"]').first();
    let rawName = flat(evidenceText($, visibleName.length ? visibleName : profileLink));
    if (!rawName) return; // A name-link shell is still loading.
    recognizableCards++;
    rawName = rawName.replace(/\s*[•·]\s*(?:1st|2nd|3rd\+?).*$/i, '').replace(/\s+(?:1st|2nd|3rd\+?)\s*$/i, '');
    if (/\blinkedin\s+member\b|anonymous|out of network|private profile/i.test(rawName)) return;
    const name = cleanName(rawName);
    if (!isValidPersonName(name) || seen.has(url)) return;
    const headlineNode = workspaceCard
      ? profileLink.closest('p').next('div').find('p').first()
      : root.find('.entity-result__primary-subtitle, .search-result__snippets, [data-view-name="search-result-lockup-subtitle"]').first();
    const headline = flat(evidenceText($, headlineNode));
    const snippet = evidenceText($, evidenceRoot).slice(0, 3500);
    const role = findDesignations(headline)[0];
    results.push({ url, title: headline ? `${name} - ${headline}` : name, snippet, name,
      designation: role ? normalizeDesignation(role.match) : '', headline });
    seen.add(url);
  });
  if (recognizableCards) return { status: 'results', results };
  if ($('.search-reusables__no-results, .search-no-results, [data-view-name="search-no-results"]').length || /\bno (?:matching )?results (?:found|for)\b|\bwe couldn.t find any results\b|\bno people found\b/i.test(text)) {
    return { status: 'empty', results: [] };
  }
  return { status: 'unexpected', results: [] };
}

function buildLinkedInQueries({ personName = '', companyName, designation = 'Director' }) {
  const company = brandTokens(companyName).join(' ') || companySearchName(companyName);
  if (!company) return [];
  const name = flat(personName);
  if (name) {
    const words = name.split(/\s+/);
    return [...new Set([`${name} ${company}`, `${words.length > 1 ? `${words[0]} ${words.at(-1)}` : name} ${company}`])];
  }
  // Director is always first; broader leadership searches are bounded.
  return [`${company} director`, `${company} founder`, `${company} CEO`];
}

function pageStatusError(status) {
  const messages = {
    not_connected: 'Click Connect LinkedIn and sign in in the opened browser, then retry.',
    verification_required: 'LinkedIn requires verification. Click Connect LinkedIn and complete the check yourself, then retry.',
    rate_limited: 'LinkedIn has limited searches for this account. Wait until LinkedIn restores access before retrying.',
    unexpected: 'LinkedIn did not display a recognized people results page. Open Connect LinkedIn to check access, then retry.',
    unavailable: 'LinkedIn could not load its people results. Check the connection and retry later.',
  };
  return unavailable(messages[status] || messages.unavailable, status);
}

/** Factory keeps browser ownership explicit and makes offline tests independent. */
function createLinkedInDirectClient(options = {}) {
  const chromium = options.chromium || require('playwright').chromium;
  const profileDir = options.profileDir || PROFILE_DIR;
  const hasProfile = options.hasProfile || (() => fs.existsSync(profileDir));
  const wait = options.pause || pause;
  const now = options.now || Date.now;
  let context = null;
  let headed = false;
  let queue = Promise.resolve();
  let lastSearchAt = -Infinity;
  let activeController = null;
  let shuttingDown = false;
  let accessProblem = null;
  let recoveryPage = null;

  function enqueue(work) {
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task;
  }

  async function ensureContext(visible = false) {
    if (shuttingDown) throw unavailable('The app is shutting down. Restart it to reconnect.');
    if (context && visible && !headed) {
      const old = context;
      context = null;
      await old.close();
    }
    if (context) return context;
    let next;
    try {
      const config = { headless: !visible, timeout: 30000, viewport: { width: 1280, height: 900 } };
      try {
        next = await chromium.launchPersistentContext(profileDir, { ...config, channel: 'chrome' });
      } catch (error) {
        // Fall back only when Chrome is not installed, never on a locked profile.
        if (!/executable.*(?:doesn.t exist|not found)|distribution.*not found|chrome.*not found/i.test(error.message || '')) throw error;
        next = await chromium.launchPersistentContext(profileDir, config);
      }
    } catch (error) {
      // Chrome hands a locked profile to its owner and exits ("Opening in existing browser session").
      const instruction = /singleton|already in use|existing browser session/i.test(error.message || '')
        ? 'The dedicated LinkedIn browser profile is already in use. Close its other browser instance, then reconnect.'
        : 'Cannot start the LinkedIn browser. Install Google Chrome or run npm run install-browser, then reconnect.';
      throw unavailable(instruction);
    }
    context = next;
    headed = visible;
    next.on('close', () => { if (context === next) { context = null; headed = false; } });
    return context;
  }

  async function statusFor(browserContext) {
    const cookies = await browserContext.cookies('https://www.linkedin.com');
    const connected = cookies.some((cookie) => cookie.name === 'li_at' &&
      linkedInHost(String(cookie.domain || '').replace(/^\./, '')) &&
      (cookie.expires === -1 || cookie.expires > now() / 1000));
    if (connected && accessProblem) {
      let recoveryComplete = false;
      if (recoveryPage && !recoveryPage.isClosed()) {
        try {
          const current = new URL(recoveryPage.url());
          recoveryComplete = linkedInHost(current.hostname) && /^\/(?:feed|mynetwork|in|search)(?:\/|$)/i.test(current.pathname);
        } catch { /* A blank/new tab does not establish a completed login. */ }
      }
      if (accessProblem.status === 'rate_limited') {
        if (now() - accessProblem.at >= RATE_LIMIT_COOLDOWN_MS) accessProblem = null;
      } else if (recoveryComplete) accessProblem = null;
      if (accessProblem) return { configured: true, connected: false, status: accessProblem.status,
        message: pageStatusError(accessProblem.status).message };
    }
    return { configured: connected, connected, status: connected ? 'connected' : 'not_connected',
      message: connected ? 'Saved LinkedIn session found; searches will confirm access.' : 'Click Connect LinkedIn and sign in in the opened browser, then retry.' };
  }

  function getLinkedInStatus() {
    return enqueue(async () => {
      if (!context && !hasProfile()) return { configured: false, connected: false, status: 'not_connected', message: 'Click Connect LinkedIn and sign in in the opened browser, then retry.' };
      try { return await statusFor(await ensureContext()); }
      catch (error) { return { configured: false, connected: false, status: 'unavailable', message: error.directSearch ? error.message : 'Cannot read the saved LinkedIn session. Reconnect LinkedIn.' }; }
    });
  }

  function connectLinkedIn() {
    return enqueue(async () => {
      const browserContext = await ensureContext(true);
      const existing = browserContext.pages().find((page) => /linkedin\.com\/(?:login|checkpoint|challenge|uas\/login)/i.test(page.url()));
      const page = existing || await browserContext.newPage();
      recoveryPage = page;
      if (!existing) {
        try { await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }); }
        catch { throw unavailable('The LinkedIn sign-in page could not load. Check the opened browser and your internet connection.'); }
      }
      await page.bringToFront();
      const status = await statusFor(browserContext);
      return { ...status, message: status.connected ? status.message : 'LinkedIn browser opened. Sign in there, then check connection in the app.' };
    });
  }

  function searchLinkedInDirect({ personName = '', companyName, designation = 'Director', log = () => {}, accept = () => true, signal } = {}) {
    const queries = buildLinkedInQueries({ personName, companyName, designation });
    if (!queries.length) return Promise.resolve([]);
    return abortable(enqueue(async () => {
      checkAbort(signal);
      const controller = new AbortController();
      activeController = controller;
      const timeout = setTimeout(() => controller.abort(unavailable('The search timed out. Check LinkedIn access and retry.')), SEARCH_TIMEOUT_MS);
      const cancel = () => controller.abort(signal.reason instanceof Error ? signal.reason : abortError());
      signal?.addEventListener('abort', cancel, { once: true });
      let page;
      const results = new Map();
      try {
        if (!context && !hasProfile()) throw pageStatusError('not_connected');
        const browserContext = await ensureContext();
        checkAbort(controller.signal);
        const status = await statusFor(browserContext);
        if (!status.connected) throw pageStatusError(status.status);
        page = await browserContext.newPage();
        controller.signal.addEventListener('abort', () => { page.close().catch(() => {}); }, { once: true });
        for (const query of queries) {
          checkAbort(controller.signal);
          await wait(Math.max(0, SEARCH_INTERVAL_MS - (now() - lastSearchAt)), controller.signal);
          lastSearchAt = now();
          log(`    Direct LinkedIn people search: ${query}`);
          const url = new URL('https://www.linkedin.com/search/results/people/');
          url.searchParams.set('keywords', query);
          const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
          let parsed = parseLinkedInPeopleHtml(await page.content(), page.url(), response?.status() || 200);
          // A result container can exist before its profile name/headline loads.
          for (let elapsed = 0; parsed.status === 'unexpected' && elapsed < RESULTS_TIMEOUT_MS; elapsed += 500) {
            await wait(500, controller.signal);
            parsed = parseLinkedInPeopleHtml(await page.content(), page.url(), response?.status() || 200);
          }
          checkAbort(controller.signal);
          if (!['empty', 'results'].includes(parsed.status)) throw pageStatusError(parsed.status);
          if (parsed.status === 'results') {
            // Load one additional viewport of visible cards, without pagination.
            await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 700)));
            await wait(600, controller.signal);
            const afterScroll = parseLinkedInPeopleHtml(await page.content(), page.url(), response?.status() || 200);
            if (!['empty', 'results'].includes(afterScroll.status)) throw pageStatusError(afterScroll.status);
            parsed.results.push(...afterScroll.results);
          }
          for (const result of parsed.results) {
            const previous = results.get(result.url);
            if (!previous || (result.snippet || '').length > (previous.snippet || '').length) results.set(result.url, result);
          }
          if (parsed.results.some(accept)) break;
        }
        return [...results.values()];
      } catch (error) {
        checkAbort(controller.signal);
        if (error.directSearch || error.name === 'AbortError') {
          if (['verification_required', 'rate_limited', 'not_connected'].includes(error.status) && !accessProblem) {
            accessProblem = { status: error.status, at: now() };
            recoveryPage = null;
          }
          throw error;
        }
        throw unavailable('The people results could not load. Check LinkedIn in Connect LinkedIn, then retry.');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        activeController = null;
        if (page) await page.close().catch(() => {});
      }
    }), signal);
  }

  function closeLinkedInBrowser() {
    shuttingDown = true;
    activeController?.abort(abortError());
    return enqueue(async () => {
      const old = context;
      context = null;
      headed = false;
      if (old) await old.close();
    });
  }

  return { searchLinkedInDirect, connectLinkedIn, getLinkedInStatus, closeLinkedInBrowser };
}

const client = createLinkedInDirectClient();
module.exports = { ...client, createLinkedInDirectClient, parseLinkedInPeopleHtml, buildLinkedInQueries, canonicalProfileUrl };
