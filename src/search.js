/**
 * Web search module.
 *
 * Two problems this solves that were silently poisoning the pipeline:
 *
 *  1. Bing's no-JS endpoint frequently ignores the query entirely and serves a
 *     cached entity page ("Nithin Kamath" -> the actor "Nithiin"). Those bogus
 *     results filled the result set, so the LinkedIn lookup never saw a single
 *     linkedin.com/in URL and every row came back NULL.
 *  2. DuckDuckGo rate-limits plain fetch (HTTP 202/403 challenge pages).
 *
 * So: several engines are tried in order, plain fetch first (cheap) and a
 * shared Playwright browser after (reliable), and every result is checked for
 * relevance against the query before it is trusted. An engine that returns
 * nothing relevant is skipped and the next one is tried.
 */

require('./env');
const { chromium } = require('playwright');
const { currentSearchConfig, noteSearchProvider } = require('./search-config');
const { runSerpapi, serpapiStatus } = require('./serpapi');
const { createOwnSearch } = require('./own-search');

const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Words that carry no discriminating power when checking relevance.
const QUERY_STOPWORDS = new Set([
  'linkedin', 'profile', 'official', 'website', 'site', 'com', 'www', 'the',
  'and', 'for', 'company', 'homepage', 'home', 'page', 'about', 'contact',
  'or', 'of', 'in', 'at', 'on', 'ceo', 'founder', 'director', 'managing',
]);

const ENGINE_HOSTS = /(?:duckduckgo|bing|yahoo|yandex|google|brave|startpage|ecosia|mojeek|searx|priv\.au|microsoft|msn)\./i;

/* ------------------------------------------------------------------ *
 * URL / entity helpers
 * ------------------------------------------------------------------ */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** Unwrap the redirect wrappers each engine puts around real result URLs. */
function normalizeUrl(href) {
  try {
    const clean = decodeEntities(String(href));

    // Yahoo: .../RU=<url-encoded>/RK=.../RS=...
    const ru = clean.match(/\/RU=([^/]+)/);
    if (ru) {
      const decoded = decodeURIComponent(ru[1]);
      if (/^https?:\/\//i.test(decoded)) return stripUrl(decoded);
    }

    const u = new URL(clean);

    // DuckDuckGo: /l/?uddg=<url-encoded>
    if (u.searchParams.has('uddg')) {
      return stripUrl(decodeURIComponent(u.searchParams.get('uddg')));
    }
    // Bing: /ck/a?...&u=a1<base64url>
    const bu = u.searchParams.get('u');
    if (bu && /^a1[A-Za-z0-9+/=_-]+$/.test(bu)) {
      try {
        const decoded = Buffer.from(
          bu.replace(/^a1/, '').replace(/-/g, '+').replace(/_/g, '/'),
          'base64'
        ).toString('utf-8');
        if (/^https?:\/\//i.test(decoded)) return stripUrl(decoded);
      } catch { /* not base64 after all */ }
    }
    // SearXNG / generic redirectors
    for (const key of ['url', 'q', 'target']) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return stripUrl(v);
    }

    if (ENGINE_HOSTS.test(u.hostname)) return null;
    return stripUrl(clean);
  } catch {
    return null;
  }
}

function stripUrl(raw) {
  try {
    const u = new URL(raw);
    if (ENGINE_HOSTS.test(u.hostname)) return null;
    if (!/^https?:$/.test(u.protocol)) return null;
    return (u.origin + u.pathname).replace(/\/$/, (m, i, s) => (s.length > 9 ? '' : m));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Relevance
 * ------------------------------------------------------------------ */

/** What the query actually demands: a site: filter, quoted phrases, tokens. */
function queryConstraints(query) {
  const site = (query.match(/\bsite:(\S+)/i) || [])[1] || '';
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const tokens = query
    .replace(/\bsite:\S+/gi, ' ')
    .replace(/"/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t));
  return { site, phrases, tokens };
}

/**
 * Would a human agree this result answers the query?
 * This is what keeps a degraded engine's cached entity page from being
 * mistaken for real results.
 */
function isRelevant(result, { site, phrases, tokens }, { trusted = false, minTokenCoverage = 0 } = {}) {
  const url = String(result.url || '').toLowerCase();
  const hay = `${url} ${String(result.title || '')} ${String(result.snippet || '')}`.toLowerCase();
  const tight = hay.replace(/[^a-z0-9]/g, '');

  if (site) {
    try {
      const wanted = new URL(`https://${site.replace(/^https?:\/\//i, '').replace(/^www\./i, '')}`);
      const actual = new URL(url);
      if (actual.hostname !== wanted.hostname && !actual.hostname.endsWith(`.${wanted.hostname}`)) return false;
      const path = wanted.pathname.replace(/\/$/, '');
      if (path && actual.pathname !== path && !actual.pathname.startsWith(`${path}/`)) return false;
    } catch { return false; }
  }

  // A real search API already did the matching, and its snippets are short
  // enough that a genuinely correct hit often fails a literal phrase test.
  // Only the site: filter is worth re-checking there.
  if (trusted) return true;

  for (const phrase of phrases) {
    const parts = phrase.split(/\s+/).filter((t) => t.length >= 3);
    if (!parts.every((t) => hay.includes(t) || tight.includes(t))) return false;
  }

  if (!phrases.length && tokens.length) {
    const hits = tokens.filter((t) => hay.includes(t) || tight.includes(t)).length;
    if (!hits || hits / tokens.length < minTokenCoverage) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Engines
 * ------------------------------------------------------------------ */

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': SEARCH_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Generic anchor scrape — works on every SERP without per-engine selectors. */
function harvestAnchors() {
  const out = [];
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (!/^https?:/i.test(href)) continue;
    const title = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
    if (title.length < 6 || title.length > 200) continue;

    let snippet = '';
    let node = a.parentElement;
    for (let i = 0; i < 4 && node; i++) {
      const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length > title.length + 40) { snippet = t.slice(0, 300); break; }
      node = node.parentElement;
    }
    out.push({ href, title, snippet });
  }
  return out;
}

function parseHtmlAnchors(html) {
  const out = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (title.length < 6 || title.length > 200) continue;
    out.push({ href: m[1], title, snippet: '' });
  }
  return out;
}

/**
 * Some engines (Yahoo) prefix the title with a rendered breadcrumb:
 *   "LinkedInhttps://in.linkedin.com › in › falguni-nayar Falguni Nayar - Nykaa"
 * Left in place it makes every title unparseable, so strip it.
 */
function cleanTitle(t) {
  return String(t || '')
    .replace(/^.{0,90}?https?:\/\/\S+(?:\s*[›»>]\s*[^\s›»>]+)*\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toResults(raw) {
  const seen = new Map();
  for (const { href, title, snippet } of raw) {
    const url = normalizeUrl(href);
    if (!url) continue;
    const key = url.toLowerCase();
    const result = { url: key, title: cleanTitle(title), snippet: cleanTitle(snippet || '') };
    const previous = seen.get(key);
    // Different engines can put the employer in either the title or snippet.
    // Keep the fuller title and all distinct excerpts for this same URL.
    if (previous) {
      const titleWords = (title) => title.trim().split(/\s+/).filter(Boolean).length;
      if (titleWords(previous.title) > titleWords(result.title) ||
          (titleWords(previous.title) === titleWords(result.title) && previous.title.length >= result.title.length)) {
        result.title = previous.title;
      }
      if (!result.snippet || previous.snippet.includes(result.snippet)) result.snippet = previous.snippet;
      else if (previous.snippet && !result.snippet.includes(previous.snippet)) {
        result.snippet = `${previous.snippet} ${result.snippet}`;
      }
    }
    seen.set(key, result);
  }
  return [...seen.values()];
}

/* ------------------------------------------------------------------ *
 * Serper (Google Search API) — the primary engine when a key is present
 * ------------------------------------------------------------------ */

const SERPER_ENDPOINT = 'https://google.serper.dev/search';

// Turned off for the rest of the process on an auth failure: a bad key will
// fail identically on every one of the hundreds of queries a run makes, and
// each attempt costs a round trip.
let serperOff = false;
let serperCredits = null;

const serperKey = () => String(process.env.SERPER_API_KEY || '').trim();
const serperEnabled = () => Boolean(serperKey()) && !serperOff;

/** Credits left according to the last successful call (null if unknown). */
const serperStatus = () => ({
  configured: Boolean(serperKey()),
  active: serperEnabled(),
  credits: serperCredits,
});

// Free Serper plans reject anything above one page of results with
// HTTP 400 "Query pattern not allowed for free accounts" — which, if left
// unhandled, fails *every* query and silently drops the whole run back onto
// the throttled scrapers. Ask for a page at a time and let a 400 walk the
// request size down once before giving up.
const SERPER_PAGE = Math.max(1, Math.min(20, Number(process.env.SERPER_NUM) || 10));

async function runSerper(query, num = SERPER_PAGE, { retryOnPattern = true } = {}) {
  // Protect every Serper entry point, including legacy connection probes.
  if (currentSearchConfig().provider !== 'serper') {
    throw new Error('Serper is disabled for the selected search provider');
  }
  const res = await fetchWithTimeout(
    SERPER_ENDPOINT,
    {
      method: 'POST',
      headers: {
        'X-API-KEY': serperKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num,
        gl: (process.env.SERPER_GL || 'in').trim(),
        hl: (process.env.SERPER_HL || 'en').trim(),
      }),
    },
    20000
  );

  if (res.status === 400 && retryOnPattern && num > 10) {
    return runSerper(query, 10, { retryOnPattern: false });
  }

  if (res.status === 401 || res.status === 403) {
    serperOff = true;
    throw new Error(
      `key rejected (HTTP ${res.status}) — check SERPER_API_KEY. ` +
        'Falling back to scraped engines for the rest of this run.'
    );
  }
  if (res.status === 429) {
    serperOff = true;
    throw new Error('out of credits / rate limited (HTTP 429) — falling back to scraped engines');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  serperOff = false;
  if (typeof data.credits === 'number') serperCredits = data.credits;

  const raw = [];
  // The knowledge panel's website field is the single most reliable answer to
  // "what is this company's official site?" — better than any organic result.
  const kg = data.knowledgeGraph;
  if (kg && kg.website) {
    raw.push({ href: kg.website, title: kg.title || '', snippet: kg.description || '' });
  }
  for (const o of data.organic || []) {
    if (!o || !o.link) continue;
    raw.push({ href: o.link, title: o.title || '', snippet: o.snippet || '' });
    for (const sl of o.sitelinks || []) {
      if (sl && sl.link) raw.push({ href: sl.link, title: sl.title || '', snippet: '' });
    }
  }
  return toResults(raw);
}

/**
 * Spend one cheap query proving the key works, so an invalid key is reported
 * in the first seconds of a job rather than inferred from a sheet of NULLs
 * twenty minutes later.
 */
async function verifySerperKey() {
  if (currentSearchConfig().provider !== 'serper') {
    return { configured: Boolean(serperKey()), ok: false, skipped: true, error: 'Serper is disabled for the selected search provider' };
  }
  if (!serperKey()) return { configured: false, ok: false, error: 'SERPER_API_KEY not set' };
  try {
    await runSerper('linkedin', 1);
    return { configured: true, ok: true, credits: serperCredits };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}

// Keep suspension state per instance. Repeating the same CAPTCHA request for
// each name cannot recover it and used to flood a job with identical errors.
const searxngSuspensions = new Map();
const searxngWarnings = new WeakMap();

function searxngState() {
  const instance = currentSearchConfig().searxngUrl;
  if (!searxngSuspensions.has(instance)) searxngSuspensions.set(instance, new Map());
  return searxngSuspensions.get(instance);
}

function warnSearxngOnce(engine, reason, log) {
  if (!log) return;
  const config = currentSearchConfig();
  if (!searxngWarnings.has(config)) searxngWarnings.set(config, new Set());
  const warnings = searxngWarnings.get(config);
  const key = `${engine}:${reason}`;
  if (warnings.has(key)) return;
  warnings.add(key);
  log(`      [searxng] ${engine}: ${reason}; temporarily skipping this engine`);
}

function searchUnavailable(message) {
  const error = new Error(message);
  error.code = 'SEARCH_UNAVAILABLE';
  return error;
}

function unavailableEngines(blocked, retryWithRemainingEngines = false) {
  const details = blocked.map(([engine, state]) => `${engine}: ${state.reason}`).join('; ');
  const error = searchUnavailable(`SearXNG upstream engines temporarily unavailable (${details}). No relevant results from the remaining engines; retry after recovery or use another working SearXNG instance`);
  error.retryWithRemainingEngines = retryWithRemainingEngines;
  return error;
}

/** Query only web engines; general categories also include Wikipedia, etc. */
async function runSearxng(query, { engines = '', log = null, signal, onWarning } = {}) {
  const url = new URL(currentSearchConfig().searxngUrl);
  const requested = [...new Set(String(engines || process.env.SEARXNG_ENGINES || 'google,bing')
    .split(',').map((engine) => engine.trim()).filter(Boolean))];
  const state = searxngState();
  for (const [engine, suspension] of state) {
    if (suspension.until <= Date.now()) state.delete(engine);
  }
  const blocked = requested.filter((engine) => state.has(engine));
  for (const engine of blocked) warnSearxngOnce(engine, state.get(engine).reason, log);
  const active = requested.filter((engine) => !state.has(engine));
  if (!active.length) throw unavailableEngines(blocked.map((engine) => [engine, state.get(engine)]));
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  // Supplying categories as well would add all category engines back in.
  url.searchParams.set('engines', active.join(','));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': SEARCH_UA },
    });
    if (res.status === 403) {
      throw new Error('HTTP 403: enable json in search.formats in your SearXNG settings.yml and check instance access');
    }
    if (res.status === 429) throw new Error('SearXNG rate limited (HTTP 429); retry later or use your own instance');
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
    let data;
    try { data = await res.json(); } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new Error('SearXNG did not return JSON. Enable json in search.formats in settings.yml');
    }
    if (!data || !Array.isArray(data.results)) throw new Error('Invalid SearXNG response: missing results array');
    const constraints = queryConstraints(query);
    const results = toResults(data.results.filter((r) => {
      if (!r || typeof r.url !== 'string') return false;
      const sources = Array.isArray(r.engines) ? r.engines : [r.engine];
      if (!sources.length || !sources.every((engine) => /^bing(?:\b|_)/i.test(engine || ''))) return true;
      // Bing sometimes returns a cached page about just the first word,
      // e.g. "Blue" instead of "Blue Tokai". These are not useful hits.
      const [result] = toResults([{ href: r.url, title: r.title, snippet: r.content }]);
      return result && isRelevant(result, constraints, { minTokenCoverage: 0.6 });
    }).map((r) => ({ href: r.url, title: r.title || '', snippet: r.content || '' })));
    for (const entry of data.unresponsive_engines || []) {
      if (!Array.isArray(entry) || !active.includes(entry[0])) continue;
      const [engine, rawReason] = entry;
      const reason = String(rawReason || 'unavailable').replace(/^Suspended:\s*/i, '');
      // These mirror ordinary CAPTCHA/rate-limit defaults in the installed
      // instance. SearXNG remains responsible for its own suspension window.
      const delay = /captcha/i.test(reason) ? 60 * 60 * 1000
        : /too many requests|access denied|HTTP 4[02][39]/i.test(reason) ? 180000 : 60000;
      state.set(engine, { reason, until: Date.now() + delay });
      warnSearxngOnce(engine, reason, log);
    }
    const unavailable = requested.filter((engine) => state.has(engine));
    for (const engine of unavailable) onWarning?.(`${engine}: ${state.get(engine).reason}`);
    if (!results.length && unavailable.length) {
      throw unavailableEngines(unavailable.map((engine) => [engine, state.get(engine)]), unavailable.length < requested.length);
    }
    return results;
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
    if (err.name === 'AbortError') throw new Error('SearXNG timed out after 20 seconds');
    if (err.message === 'fetch failed') throw new Error('Cannot reach SearXNG. Check the instance URL and that it is running');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const hybridWarnings = new WeakMap();

/** Race usable results, not HTTP responses: an empty/irrelevant fast engine
 * must not suppress a slower engine's verified LinkedIn profile. */
function runHybrid(query, { accept = null, searxngEngines = '', log = null } = {}) {
  const config = currentSearchConfig();
  const constraints = queryConstraints(query);
  const controllers = [new AbortController(), new AbortController()];
  const labels = ['SerpApi', 'SearXNG'];
  const warnings = [];
  const collected = [];
  const sources = [];
  let pending = 2;
  let successes = 0;
  let finished = false;
  if (!hybridWarnings.has(config)) hybridWarnings.set(config, new Set());
  const warned = hybridWarnings.get(config);

  return new Promise((resolve, reject) => {
    const complete = () => {
      if (finished) return;
      finished = true;
      controllers.forEach((controller) => controller.abort());
      if (!successes) {
        reject(searchUnavailable(`Both search providers are unavailable. ${warnings.join('; ')}`));
      } else {
        const results = toResults(collected.map((r) => ({ href: r.url, title: r.title, snippet: r.snippet })));
        resolve({ results, warnings, source: sources.join(' + ') });
      }
    };
    const tasks = [
      () => runSerpapi(query, { signal: controllers[0].signal }).then(toResults),
      () => runSearxng(query, { engines: searxngEngines, log, signal: controllers[1].signal }),
    ];
    tasks.forEach((task, index) => {
      Promise.resolve().then(task).then((raw) => {
        if (finished) return;
        successes++;
        const results = raw.filter((r) => isRelevant(r, constraints, { trusted: true }));
        sources.push(labels[index]);
        collected.push(...results);
        if (log) log(`      [hybrid/${labels[index]}] ${results.length} relevant result(s)`);
        pending--;
        if (results.some(accept || (() => true)) || !pending) complete();
      }, (err) => {
        if (finished) return;
        const warning = `${labels[index]}: ${err.message}`;
        warnings.push(warning);
        if (log && !warned.has(warning)) {
          warned.add(warning);
          log(`      [hybrid] ${warning}; continuing with the other provider`);
        }
        pending--;
        if (!pending) complete();
      });
    });
  });
}

const ownSearch = createOwnSearch({ runSearxng, queryConstraints, isRelevant });

async function verifySearchProvider() {
  if (currentSearchConfig().provider === 'linkedin') {
    const status = await require('./linkedin-direct').getLinkedInStatus();
    return { configured: status.configured, ok: status.connected,
      ...(status.connected ? {} : { error: status.message || 'Connect LinkedIn and sign in before starting.' }) };
  }
  if (currentSearchConfig().provider === 'own') {
    try {
      const check = await ownSearch.search('LinkedIn official website');
      if (!check.results.length) throw new Error('Own Search returned no results for the connection check');
      return { configured: true, ok: true, warnings: check.warnings, respondingProvider: check.sources.join(' + ') };
    } catch (err) {
      return { configured: true, ok: false, error: err.message };
    }
  }
  if (currentSearchConfig().provider === 'hybrid') {
    try {
      const check = await runHybrid('linkedin');
      if (!check.results.length) throw new Error('Neither provider returned results for the connection check');
      return { configured: true, ok: true, warnings: check.warnings, respondingProvider: check.source };
    } catch (err) {
      return { configured: true, ok: false, error: err.message };
    }
  }
  if (currentSearchConfig().provider === 'serper') return verifySerperKey();
  if (currentSearchConfig().provider === 'serpapi') {
    try {
      const results = toResults(await runSerpapi('linkedin'));
      if (!results.length) throw new Error('SerpApi returned no search results for the connection check');
      return { ...serpapiStatus(), ok: true };
    } catch (err) {
      return { ...serpapiStatus(), ok: false, error: err.message };
    }
  }
  try {
    const results = await runSearxng('linkedin');
    if (!results.length) throw new Error('SearXNG returned no search results for the connection check; check that its search engines are working');
    const warnings = [...searxngState()].filter(([, state]) => state.until > Date.now())
      .map(([engine, state]) => `${engine}: ${state.reason}`);
    return { configured: true, ok: true, ...(warnings.length ? { warnings } : {}) };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}

/**
 * Order matters. Bing's endpoints are last because when they are throttled
 * they do not error — they return a cached entity page for a *different*
 * subject ("Tata Consultancy Services" -> Tata Motors car listings), which is
 * far more damaging than an empty result set.
 */
const ENGINES = [
  { name: 'ddg-html', mode: 'fetch', url: (q) => `https://html.duckduckgo.com/html/?q=${q}` },
  { name: 'yahoo', mode: 'browser', url: (q) => `https://search.yahoo.com/search?p=${q}&n=20` },
  { name: 'searxng', mode: 'browser', url: (q) => `https://priv.au/search?q=${q}` },
  { name: 'brave', mode: 'browser', url: (q) => `https://search.brave.com/search?q=${q}` },
  { name: 'ddg-browser', mode: 'browser', url: (q) => `https://duckduckgo.com/?q=${q}&ia=web` },
  { name: 'bing', mode: 'fetch', url: (q) => `https://www.bing.com/search?q=${q}&count=20` },
  { name: 'bing-browser', mode: 'browser', url: (q) => `https://www.bing.com/search?q=${q}&count=20` },
];

// Engines that just failed get benched for a while instead of being retried.
const cooldown = new Map();
const COOLDOWN_MS = 90000;

function onCooldown(name) {
  const until = cooldown.get(name);
  return Boolean(until && until > Date.now());
}

/**
 * An engine is only benched after several *consecutive* completely-empty
 * responses, which indicates throttling rather than a query that genuinely
 * has no matches.
 */
const failStreak = new Map();
const EMPTY_STREAK_LIMIT = 3;

function noteEngineOk(name) {
  failStreak.set(name, 0);
}

function noteEngineEmpty(name) {
  const streak = (failStreak.get(name) || 0) + 1;
  failStreak.set(name, streak);
  if (streak >= EMPTY_STREAK_LIMIT) {
    cooldown.set(name, Date.now() + COOLDOWN_MS);
    failStreak.set(name, 0);
  }
}

/* ------------------------------------------------------------------ *
 * Shared browser
 * ------------------------------------------------------------------ */

let browserPromise = null;
let searchPage = null;

async function getSearchPage() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
  }
  const browser = await browserPromise;
  if (searchPage && !searchPage.isClosed()) return searchPage;

  const context = await browser.newContext({
    userAgent: SEARCH_UA,
    locale: 'en-US',
    viewport: { width: 1366, height: 850 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  searchPage = await context.newPage();
  await searchPage.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
    return route.continue();
  });
  return searchPage;
}

/** Release the shared search browser (call when a job finishes). */
async function closeSearchBrowser() {
  try {
    if (browserPromise) {
      const b = await browserPromise;
      await b.close();
    }
  } catch { /* already gone */ }
  browserPromise = null;
  searchPage = null;
}

async function runEngine(engine, encodedQuery) {
  const url = engine.url(encodedQuery);

  if (engine.mode === 'fetch') {
    const res = await fetchWithTimeout(url, {}, 20000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return toResults(parseHtmlAnchors(await res.text()));
  }

  const page = await getSearchPage();
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);
  await page.waitForTimeout(1800 + Math.random() * 1200);
  return toResults(await page.evaluate(harvestAnchors));
}

/**
 * Run a search query, moving to the next engine until one returns results
 * that are actually relevant to the query.
 * Returns [{ url, title, snippet }].
 */
// Each engine round-trip costs seconds; identical queries recur constantly.
const queryCache = new Map();
const QUERY_CACHE_MAX = 500;
const QUERY_CACHE_TTL_MS = 10 * 60 * 1000;

async function searchWeb(query, { limit = 15, log = null, searxngEngines = '', accept = null } = {}) {
  const config = currentSearchConfig();
  // Direct mode uses structured name/company lookups. Never let a generic
  // query fall through to a paid API or a throttled scraped search engine.
  if (config.provider === 'linkedin') {
    throw Object.assign(new Error('LinkedIn Direct uses people search by director name and company.'), { code: 'SEARCH_UNAVAILABLE' });
  }
  if (config.provider === 'own') {
    const response = await ownSearch.search(query, { limit, log, searxngEngines, accept });
    noteSearchProvider('own');
    if (log && response.cached) log(`      [own/cache] ${response.results.length} result(s)`);
    return response.results;
  }
  const usesSearxng = ['searxng', 'hybrid'].includes(config.provider);
  const cacheKey = JSON.stringify([config.provider, usesSearxng ? config.searxngUrl : '',
    usesSearxng ? searxngEngines : '', query.toLowerCase().trim()]);
  if (queryCache.get(cacheKey)?.expiresAt > Date.now() &&
      (!accept || queryCache.get(cacheKey).results.some(accept))) {
    const { results, source } = queryCache.get(cacheKey);
    noteSearchProvider(source);
    if (log) log(`      [cache: ${source}] ${results.length} result(s)`);
    return results.slice(0, limit);
  }
  queryCache.delete(cacheKey);

  const encoded = encodeURIComponent(query);
  const constraints = queryConstraints(query);
  let lastRelevant = [];
  let providerFailure = null;

  const remember = (results, source = config.provider) => {
    // Empty or filtered-out results must be retried after engines recover.
    if (!results.length) return [];
    if (queryCache.size >= QUERY_CACHE_MAX) {
      queryCache.delete(queryCache.keys().next().value);
    }
    queryCache.set(cacheKey, { results, source, expiresAt: Date.now() + QUERY_CACHE_TTL_MS });
    return results.slice(0, limit);
  };

  // A successful API response is final, including a valid empty result set.
  // Provider failures may use scraped engines, but never the other paid API.
  // SerpApi failures surface explicitly so quota/network failures cannot be
  // mistaken for missing directors or spend credits on another paid service.
  if (config.provider === 'hybrid') {
    const { results, source } = await runHybrid(query, { accept, searxngEngines, log });
    noteSearchProvider(source);
    return remember(results, source);
  }
  if (config.provider === 'serpapi') {
    const results = toResults(await runSerpapi(query));
    const relevant = results.filter((r) => isRelevant(r, constraints, { trusted: true }));
    if (log) log(`      [serpapi] ${results.length} raw / ${relevant.length} relevant`);
    noteSearchProvider('serpapi');
    return remember(relevant);
  }
  if (config.provider === 'searxng') {
    const source = searxngEngines ? `searxng/${searxngEngines}` : 'searxng';
    try {
      if (log && searxngEngines) log(`      [${source}] searching: ${query}`);
      const results = await runSearxng(query, { engines: searxngEngines, log });
      const relevant = results.filter((r) => isRelevant(r, constraints, { trusted: true }));
      if (log) log(`      [${source}] ${results.length} raw / ${relevant.length} relevant`);
      noteSearchProvider(source);
      return remember(relevant, source);
    } catch (err) {
      // A suspended upstream engine is an incomplete search, not proof that
      // a director/profile does not exist. The caller may try another query
      // on remaining healthy engines, without launching scraper loops.
      if (err.code === 'SEARCH_UNAVAILABLE') throw err;
      if (searxngEngines) {
        throw searchUnavailable(`SearXNG search temporarily unavailable: ${err.message}`);
      }
      providerFailure = err;
      if (log) log(`      [searxng] failed: ${err.message}; trying scraped engines`);
    }
  }

  if (config.provider === 'serper' && serperEnabled()) {
    try {
      const results = await runSerper(query);
      const relevant = results.filter((r) => isRelevant(r, constraints, { trusted: true }));
      if (log) {
        log(`      [serper] ${results.length} raw / ${relevant.length} relevant` +
            (serperCredits === null ? '' : ` (${serperCredits} credits left)`));
      }
      noteSearchProvider('serper');
      return remember(relevant);
    } catch (err) {
      if (log) log(`      [serper] failed: ${err.message}`);
    }
  }

  noteSearchProvider('scraped engines');
  for (const engine of ENGINES) {
    if (onCooldown(engine.name)) continue;
    try {
      const results = await runEngine(engine, encoded);
      const relevant = results.filter((r) => isRelevant(r, constraints));
      if (log) log(`      [${engine.name}] ${results.length} raw / ${relevant.length} relevant`);

      if (relevant.length > 0) {
        noteEngineOk(engine.name);
        return remember(relevant, 'scraped engines');
      }
      // A narrow site: query returning nothing is a normal, correct answer —
      // NOT engine failure. Benching on it used to knock out every engine in
      // turn over a long run, after which every lookup returned NULL.
      if (results.length === 0) noteEngineEmpty(engine.name);
      else noteEngineOk(engine.name);
      lastRelevant = [];
    } catch (err) {
      if (log) log(`      [${engine.name}] failed: ${err.message}`);
      cooldown.set(engine.name, Date.now() + COOLDOWN_MS);
      failStreak.set(engine.name, 0);
    }
    await sleep(400 + Math.random() * 600);
  }
  // Don't cache emptiness: a transient block must not pin this query to NULL
  // for the rest of the process.
  if (providerFailure) throw searchUnavailable(`SearXNG and its search fallbacks are temporarily unavailable: ${providerFailure.message}`);
  return lastRelevant.slice(0, limit);
}

/**
 * Try multiple query variants, accumulating results.
 *
 * `accept` lets the caller say what a *useful* result looks like (e.g. an
 * actual linkedin.com/in URL). Without it the loop used to stop as soon as it
 * had 5 results of any kind — so a first query full of irrelevant hits
 * short-circuited the `site:linkedin.com/in` follow-ups and every lookup came
 * back NULL.
 */
async function searchWithFallbackQueries(buildQueries, opts = {}) {
  const { accept = null, minAccepted = 2, minResults = 5, log = null, searxngEngines = '' } = opts;
  const queries = buildQueries();
  const allSeen = new Map();
  let unavailable = null;

  for (const [index, q] of queries.entries()) {
    let results;
    try {
      results = await searchWeb(q, { log, searxngEngines, accept });
    } catch (err) {
      if (err.code !== 'SEARCH_UNAVAILABLE') throw err;
      unavailable = err;
      if (!err.retryWithRemainingEngines) break;
      results = [];
    }
    for (const r of results) {
      const previous = allSeen.get(r.url);
      // A later query may expose the employer in a previously empty snippet.
      // Keep that evidence instead of pinning the profile to its first hit.
      if (!previous || (accept && accept(r) && !accept(previous)) ||
          ((!accept || !accept(previous)) &&
           `${r.title || ''} ${r.snippet || ''}`.length > `${previous.title || ''} ${previous.snippet || ''}`.length)) {
        allSeen.set(r.url, r);
      }
    }

    const values = [...allSeen.values()];
    const enough = accept
      ? values.filter(accept).length >= minAccepted
      : values.length >= minResults;
    if (enough) break;

    // The pacing exists to keep scraped engines from throttling us. An API
    // key has no such problem, and the delay dominates the runtime.
    const provider = currentSearchConfig().provider;
    if (index < queries.length - 1 && !['serpapi', 'hybrid'].includes(provider) && (provider !== 'serper' || !serperEnabled())) {
      await sleep(600 + Math.random() * 900);
    }
  }
  const values = [...allSeen.values()];
  if (unavailable && !values.some(accept || (() => true))) throw unavailable;
  return values;
}

module.exports = {
  searchWeb,
  searchWithFallbackQueries,
  closeSearchBrowser,
  isRelevant,
  queryConstraints,
  normalizeUrl,
  serperEnabled,
  serperStatus,
  serpapiStatus,
  verifySerperKey,
  verifySearchProvider,
  runSearxng,
  ownSearch,
};
