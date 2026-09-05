/**
 * ZaubaCorp fallback source.
 *
 * Used when the official website is missing or website research leaves
 * directors without LinkedIn URLs. The registry supplies names; web search
 * supplies the LinkedIn profile URLs.
 *
 * It does three things, each of which can fail with a stated reason:
 *
 *   1. locate the company's ZaubaCorp page (web search first, ZaubaCorp's own
 *      search endpoint second) and prove the page is about THIS company using
 *      normalized-token similarity, not a substring test;
 *   2. open #director-information ("Directors") and read its current director
 *      tables, retaining registry details; support older layouts when absent;
 *   3. verify each name on LinkedIn with strict name+company rules, so a
 *      registry name is never written into the report attached to a stranger's
 *      profile.
 *
 * ZaubaCorp sits behind Cloudflare and answers plain fetch with 403, so page
 * loads go through Playwright — the same approach crawler.js already takes for
 * company sites.
 */

require('./env');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

const { searchWithFallbackQueries } = require('./search');
const { brandTokens } = require('./normalize');
const { isPersonalProfileUrl, validateLinkedInCandidate } = require('./linkedin');
const {
  cleanName,
  isValidPersonName,
  looksLikeDesignation,
  normalizeDesignation,
  nameKey,
  companyTokensOf,
} = require('./person');

/** Values written into the report's Source column. */
const ZAUBA_SOURCE = 'ZaubaCorp';
const ZAUBA_SEARCH_SOURCE = 'ZaubaCorp (search result)';
const WEBSITE_SOURCE = 'Official Website';

const ZAUBA_HOST = 'www.zaubacorp.com';
const DIRECTOR_SECTION = '#director-information';

// Confidence bands for "is this ZaubaCorp page the company we asked about?"
const MATCH_ACCEPT = 0.72;
const MATCH_HIGH = 0.88;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Company-name matching
 *
 * Registered names differ from the names people type in every predictable
 * way: legal suffixes, plurals, punctuation, spelling slips. Comparing raw
 * strings (or worse, substrings) matches "TIMES COMTRADE" to "TIMES GREEN
 * POWER", so everything is reduced to normalized tokens first and scored.
 * ------------------------------------------------------------------ */

// Extra entity forms brandTokens() does not strip, plus registry noise.
const EXTRA_LEGAL_TOKENS = new Set([
  'opc', 'nidhi', 'producer', 'unlimited', 'registered', 'regd',
]);

// Tokens too common to prove two companies are the same on their own.
const GENERIC_TOKENS = new Set([
  'india', 'indian', 'bharat', 'international', 'global', 'national',
  'enterprise', 'enterprises', 'industry', 'industries', 'service', 'services',
  'solution', 'solutions', 'technology', 'technologies', 'venture', 'ventures',
  'trading', 'trader', 'traders', 'trade', 'export', 'exports', 'import',
  'imports', 'group', 'holding', 'holdings', 'corporation', 'company',
  'associates', 'agency', 'agencies', 'consultancy', 'consultants',
  'consulting', 'projects', 'infra', 'infrastructure', 'developers',
  'builders', 'new', 'shree', 'shri', 'sri', 'the',
]);

/** "roasters" -> "roaster", "industries" -> "industry", "sons" -> "son". */
function singularize(token) {
  const t = String(token || '');
  if (t.length <= 3) return t;
  if (/[^aeiou]ies$/.test(t)) return `${t.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(t)) return t.slice(0, -2);
  if (/[^s]s$/.test(t)) return t.slice(0, -1);
  return t;
}

/**
 * Comparable token list for a company name: punctuation gone, legal entity
 * forms gone, plurals collapsed.
 * "Blue Tokai Coffee Roasters Private Limited" -> [blue, tokai, coffee, roaster]
 */
function normalizedTokens(rawName) {
  return brandTokens(rawName)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t && !EXTRA_LEGAL_TOKENS.has(t))
    .map(singularize)
    .filter(Boolean);
}

/** Classic Levenshtein, with an early exit on hopeless pairs. */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Same word allowing for a spelling slip or a shortened form. */
function tokensMatch(a, b) {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 5 && longer.startsWith(shorter)) return true;
  const budget = longer.length <= 5 ? 1 : 2;
  return levenshtein(a, b) <= budget;
}

/**
 * How confident are we that `candidateName` names the same company as
 * `inputName`? Returns 0..1. Coverage (is all of the input explained?)
 * dominates, with precision (is the candidate free of unexplained extra
 * words?) as the check that stops a short name matching a longer, different
 * one.
 */
function companyNameSimilarity(inputName, candidateName) {
  const a = [...new Set(normalizedTokens(inputName))];
  const b = [...new Set(normalizedTokens(candidateName))];
  if (!a.length || !b.length) return { score: 0, distinctive: false };

  const usedB = new Set();
  let matched = 0;
  let distinctive = false;

  for (const ta of a) {
    const hitIndex = b.findIndex((tb, i) => !usedB.has(i) && tokensMatch(ta, tb));
    if (hitIndex === -1) continue;
    usedB.add(hitIndex);
    matched++;
    // A shared "india" or "services" proves nothing; a shared "comtrade" does.
    if (ta.length >= 4 && !GENERIC_TOKENS.has(ta)) distinctive = true;
  }

  const coverage = matched / a.length;
  const precision = matched / b.length;
  return { score: 0.65 * coverage + 0.35 * precision, distinctive };
}

/**
 * Decide whether a ZaubaCorp result is the company we want.
 * Returns { accepted, score, confidence, reason }.
 */
function matchCompanyName(inputName, candidateName) {
  const { score, distinctive } = companyNameSimilarity(inputName, candidateName);
  const rounded = Math.round(score * 100) / 100;

  if (!distinctive) {
    return {
      accepted: false,
      score: rounded,
      confidence: 'low',
      reason: 'no distinctive company word in common',
    };
  }
  if (score < MATCH_ACCEPT) {
    return {
      accepted: false,
      score: rounded,
      confidence: 'low',
      reason: `name similarity ${rounded} below ${MATCH_ACCEPT}`,
    };
  }
  return {
    accepted: true,
    score: rounded,
    confidence: score >= MATCH_HIGH ? 'high' : 'medium',
    reason: '',
  };
}

/* ------------------------------------------------------------------ *
 * ZaubaCorp URLs
 * ------------------------------------------------------------------ */

// /COMPANY-NAME-<CIN>, e.g. /TIMES-COMTRADE-PRIVATE-LIMITED-U34100GJ2006PTC049120
const COMPANY_PATH_RE = /^\/([A-Za-z0-9&'.\-%]+)-([A-Za-z][A-Za-z0-9-]{7,30})\/?$/;
// Search indexes still return the older /company/COMPANY-NAME/CIN layout.
const LEGACY_COMPANY_PATH_RE = /^\/company\/([A-Za-z0-9&'.\-%]+)\/([A-Za-z][A-Za-z0-9-]{7,30})\/?$/i;

/** A ZaubaCorp *company* page (not a director page, not a listing page). */
function parseCompanyUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.hostname.replace(/^www\./i, '').toLowerCase() !== 'zaubacorp.com') return null;

  const m = u.pathname.match(COMPANY_PATH_RE) || u.pathname.match(LEGACY_COMPANY_PATH_RE);
  if (!m) return null;

  let slug;
  try { slug = decodeURIComponent(m[1]); } catch { return null; }
  const id = m[2];
  // A CIN is a letter followed by digits and letters (U34100GJ2006PTC049120);
  // an LLPIN looks like AAK-7453. Director pages end in a bare 8-digit DIN,
  // which this rejects because it has no leading letter.
  if (!/^[A-Za-z]\d{5}[A-Za-z]{2}\d{4}[A-Za-z]{3}\d{6}$/.test(id) &&
      !/^[A-Za-z]{3}-?\d{4}$/.test(id)) {
    return null;
  }

  // The search layer lowercases every URL it returns; ZaubaCorp's canonical
  // slugs are upper case. It redirects either way, but asking for the
  // canonical form avoids a redirect hop on every single lookup.
  const canonical = `https://${ZAUBA_HOST}/${slug.toUpperCase()}-${id.toUpperCase()}`;
  return {
    url: canonical,
    cin: id.toUpperCase(),
    nameFromSlug: slug.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim(),
  };
}

/* ------------------------------------------------------------------ *
 * Page fetching (Cloudflare-aware, one shared browser per run)
 * ------------------------------------------------------------------ */

let browserPromise = null;
let zaubaPage = null;

async function getZaubaPage() {
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
  if (zaubaPage && !zaubaPage.isClosed()) return zaubaPage;

  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1366, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  zaubaPage = await context.newPage();
  await zaubaPage.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
    return route.continue();
  });
  return zaubaPage;
}

/** Release the ZaubaCorp browser (called once a job finishes). */
async function closeZaubaBrowser() {
  try {
    if (browserPromise) {
      const b = await browserPromise;
      await b.close();
    }
  } catch { /* already gone */ }
  browserPromise = null;
  zaubaPage = null;
}

const CHALLENGE_RE =
  /(performing security verification|checking your browser|just a moment|attention required|verify you are (a )?human|enable javascript and cookies)/i;

/** Open the Directors accordion/tab before taking the HTML snapshot. */
async function openDirectorInformation(page, log = () => {}) {
  const opened = await page.evaluate(() => {
    const section = document.getElementById('director-information');
    let clicked = false;
    const controls = [...document.querySelectorAll('button,a,[role="button"],summary')];
    for (const control of controls) {
      const label = (control.textContent || '').replace(/\s+/g, ' ').trim();
      const target = control.getAttribute('data-bs-target') || control.getAttribute('data-target') ||
        control.getAttribute('href') || (control.getAttribute('aria-controls') ? `#${control.getAttribute('aria-controls')}` : '');
      const namedDirectors = /^Directors(?:\s+(?:of|and|&).*)?$/i.test(label);
      if (target !== '#director-information' && !namedDirectors) continue;
      // Only section controls, never a link to a different page or report.
      if (target && !target.startsWith('#')) continue;
      const panel = target.startsWith('#') ? document.getElementById(target.slice(1)) : section;
      const details = control.closest('details');
      const collapsed = control.getAttribute('aria-expanded') === 'false' ||
        control.getAttribute('aria-selected') === 'false' ||
        (details && !details.open) || (panel && getComputedStyle(panel).display === 'none');
      if (collapsed || (namedDirectors && !section?.querySelector('table') && control.getAttribute('aria-expanded') !== 'true')) {
        control.click();
        clicked = true;
      }
    }
    return { present: Boolean(section), clicked };
  });

  if (!opened.present && !opened.clicked) {
    log('    ZaubaCorp #director-information not present; checking the older director layout');
    return;
  }
  log('    opening ZaubaCorp Directors (#director-information)');
  const section = page.locator(DIRECTOR_SECTION).first();
  try {
    await section.waitFor({ state: 'attached', timeout: 8000 });
    await section.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.waitForFunction(() => {
      const section = document.getElementById('director-information');
      if (!section) return false;
      const content = [section];
      if (section.matches('h1,h2,h3,h4,h5,h6,a')) {
        let sibling = section.nextElementSibling;
        while (sibling && !sibling.matches('h1,h2,h3,h4,h5,h6,section')) {
          content.push(sibling);
          sibling = sibling.nextElementSibling;
        }
      }
      return content.some((element) => element.querySelector('tr td') ||
        /no (?:current )?directors|directors? (?:information |details )?(?:not available|unavailable)/i.test(element.textContent || ''));
    }, null, { timeout: 8000 });
  } catch {
    log('    ZaubaCorp Directors section did not populate before the timeout');
  }
}

/**
 * Load a ZaubaCorp URL and return its HTML, or null with the reason logged.
 * Cloudflare serves an interstitial that resolves itself after a few seconds,
 * so a challenge is retried rather than treated as a dead end.
 */
async function loadZaubaHtml(url, log, { attempts = 3, directors = false } = {}) {
  const page = await getZaubaPage();

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const status = resp ? resp.status() : 0;
      await page.waitForTimeout(1500 + Math.random() * 1200);

      const text = await page
        .evaluate(() => (document.body ? document.body.innerText : ''))
        .catch(() => '');

      if (CHALLENGE_RE.test(text) || (status === 403 && text.length < 4000)) {
        log(`    ZaubaCorp challenge on attempt ${attempt}/${attempts} (HTTP ${status})`);
        await sleep(4000 + attempt * 2500);
        continue;
      }
      if (status >= 400 && status !== 403) {
        log(`    ZaubaCorp returned HTTP ${status}`);
        return null;
      }
      if (directors) await openDirectorInformation(page, log);
      return await page.content();
    } catch (err) {
      log(`    ZaubaCorp load failed (attempt ${attempt}): ${err.message}`);
      await sleep(2000 * attempt);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Finding the right ZaubaCorp page
 * ------------------------------------------------------------------ */

/**
 * Candidates from ordinary web search, through the existing search.js
 * relevance filtering. The result TITLE is the registered company name on
 * ZaubaCorp, so most matching is settled without spending a page load.
 */
async function searchZaubaCandidates(companyName, log) {
  const brand = brandTokens(companyName).join(' ') || companyName;
  const results = await searchWithFallbackQueries(
    () => [
      `site:zaubacorp.com "${companyName}"`,
      `site:zaubacorp.com "${brand}"`,
      `zaubacorp "${companyName}" directors`,
      `zaubacorp ${brand} company directors`,
    ],
    {
      accept: (r) => {
        const parsed = parseCompanyUrl(r.url);
        return parsed && (matchCompanyName(companyName, parsed.nameFromSlug).accepted ||
          matchCompanyName(companyName, r.title).accepted);
      },
      minAccepted: 1,
      log,
    }
  );

  const out = [];
  const seen = new Set();
  for (const r of results) {
    const parsed = parseCompanyUrl(r.url);
    if (!parsed || seen.has(parsed.cin)) continue;
    seen.add(parsed.cin);
    // Prefer the title (the registered name as ZaubaCorp prints it); the slug
    // says the same thing and covers results whose title got mangled.
    const title = String(r.title || '').replace(/\s*[|-]\s*Zauba.*$/i, '').trim();
    out.push({
      ...parsed,
      candidateName: title.length >= 4 ? title : parsed.nameFromSlug,
      altName: parsed.nameFromSlug,
    });
  }
  return { candidates: out, results };
}

/**
 * ZaubaCorp's own company search. Used only when web search produced nothing
 * usable — it is aggressively rate limited, so it is a second chance rather
 * than the primary route.
 */
async function searchZaubaDirectly(companyName, log) {
  const slug = (brandTokens(companyName).join(' ') || companyName)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!slug) return [];

  const url = `https://${ZAUBA_HOST}/companysearchresults/${slug}`;
  log(`    trying ZaubaCorp site search: ${url}`);
  const html = await loadZaubaHtml(url, log, { attempts: 2 });
  if (!html) {
    log('    ZaubaCorp site search unavailable (blocked or empty)');
    return [];
  }

  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    let abs;
    try {
      abs = new URL(href, `https://${ZAUBA_HOST}/`).toString();
    } catch {
      return;
    }
    const parsed = parseCompanyUrl(abs);
    if (!parsed || seen.has(parsed.cin)) return;
    seen.add(parsed.cin);
    const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    out.push({
      ...parsed,
      candidateName: text.length >= 4 ? text : parsed.nameFromSlug,
      altName: parsed.nameFromSlug,
    });
  });
  return out;
}

/** Best-scoring candidate that clears the confidence bar, or null. */
function pickBestCandidate(companyName, candidates, log) {
  let best = null;
  for (const c of candidates) {
    // Score both the printed name and the slug-derived name; a mangled title
    // should not sink a page whose URL says exactly the right thing.
    const byName = matchCompanyName(companyName, c.candidateName);
    const bySlug = matchCompanyName(companyName, c.altName || '');
    const chosen = bySlug.score > byName.score ? bySlug : byName;
    log(`    candidate: ${c.candidateName} (score ${chosen.score}, ${chosen.confidence})`);
    if (!chosen.accepted) continue;
    if (!best || chosen.score > best.match.score) best = { ...c, match: chosen };
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Reading directors off a company page
 * ------------------------------------------------------------------ */

/** Title-case a registry designation, keeping it a designation. */
function tidyZaubaDesignation(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 60) return 'Director';
  if (!looksLikeDesignation(text)) return 'Director';
  // ZaubaCorp's cell is already a clean canonical label ("Additional
  // Director", "Whole-time director"), so only the casing needs fixing.
  const cased = text
    .toLowerCase()
    .replace(/(^|[\s\-/&])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
  return normalizeDesignation(cased) || cased;
}

/**
 * Header cells of a table, lowercased. Used to tell the three lookalike
 * tables on a ZaubaCorp page apart:
 *   Current / Past directors -> DIN | Director Name | Designation | ...
 *   Other directorships      -> Company Name | CIN | Designation | ...
 */
function tableHeaders($, table) {
  const cells = [];
  $(table)
    .find('thead th, thead td')
    .each((_, th) => cells.push(($(th).text() || '').replace(/\s+/g, ' ').trim().toLowerCase()));
  if (cells.length) return cells;
  $(table)
    .find('tr')
    .first()
    .find('th, td')
    .each((_, th) => cells.push(($(th).text() || '').replace(/\s+/g, ' ').trim().toLowerCase()));
  return cells;
}

/** Nearest heading text above a table — tells "Current" from "Past". */
function headingAbove($, table) {
  let node = $(table);
  for (let hops = 0; hops < 6 && node.length; hops++) {
    const prev = node.prevAll('h1,h2,h3,h4,h5,h6,p,strong,b').first();
    if (prev.length) return (prev.text() || '').replace(/\s+/g, ' ').trim();
    node = node.parent();
  }
  return '';
}

/**
 * Extract directors from a ZaubaCorp company page.
 * Returns current appointments with names, roles, DIN/DPIN and appointment dates.
 */
function parseDirectorsFromHtml(html, companyName = '') {
  const $ = cheerio.load(html);
  const companyTokens = companyTokensOf(companyName);
  const found = new Map();

  const push = (rawName, rawDesignation, din, appointmentDate = '') => {
    const name = cleanName(String(rawName || '').replace(/\s+/g, ' ').trim());
    if (!isValidPersonName(name, { companyTokens })) return;
    const key = nameKey(name);
    if (!key || found.has(key)) return;
    found.set(key, {
      name,
      designation: tidyZaubaDesignation(rawDesignation),
      din: din || null,
      appointmentDate: appointmentDate || null,
      source: ZAUBA_SOURCE,
    });
  };

  const section = $(DIRECTOR_SECTION).first();
  let tables = section.find('table').add(section.filter('table'));
  // Some layouts put the fragment ID on the heading above the table.
  if (section.is('h1,h2,h3,h4,h5,h6,a')) {
    const content = section.nextUntil('h1,h2,h3,h4,h5,h6,section');
    tables = tables.add(content.filter('table')).add(content.find('table'));
  }
  if (!section.length) tables = $('table');

  tables.each((_, table) => {

    const headers = tableHeaders($, table);
    const headerLine = headers.join(' | ');
    // "Other Directorships of <person>" lists companies, not people.
    if (headerLine.includes('company name') || headerLine.includes('cin')) return undefined;

    const nameCol = headers.findIndex((h) => /\bname\b|^directors?$/.test(h));
    if (nameCol === -1) return undefined;
    const desigCol = headers.findIndex((h) => /designation|role/.test(h));
    const dinCol = headers.findIndex((h) => /^din|dpin/.test(h));
    const cessationCol = headers.findIndex((h) => /cessation|resign/.test(h));
    const appointmentCol = headers.findIndex((h) => /appoint|joining/.test(h));

    // Past appointments sit in their own table under a "Past ..." heading and
    // also carry a cessation column. Either signal is enough to skip it.
    const heading = headingAbove($, table).toLowerCase();
    if (/\bpast\b|\bformer\b|\bresigned\b/.test(heading)) return undefined;

    $(table)
      .find('tr')
      .each((_, tr) => {
        const cells = $(tr)
          .children('td')
          .toArray()
          .map((td) => ($(td).text() || '').replace(/\s+/g, ' ').trim());
        if (!cells.length || nameCol >= cells.length) return undefined;
        // A filled cessation date means the person has already left.
        if (cessationCol !== -1 && cessationCol < cells.length) {
          const ceased = cells[cessationCol];
          if (ceased && !/^(?:[-–—]|n\/?a|nil|none|not applicable|ongoing|present)$/i.test(ceased)) return undefined;
        }
        push(
          cells[nameCol],
          desigCol !== -1 && desigCol < cells.length ? cells[desigCol] : '',
          dinCol !== -1 && dinCol < cells.length ? cells[dinCol] : '',
          appointmentCol !== -1 && appointmentCol < cells.length ? cells[appointmentCol] : ''
        );
        return undefined;
      });
    return undefined;
  });

  // An existing Directors section is authoritative, including an empty one.
  // Do not replace it with stale prose or a similarly-shaped unrelated table.
  if (section.length || found.size) return [...found.values()];

  // Fallback: the summary paragraph, which survives layout changes.
  // "Directors of TIMES COMTRADE PRIVATE LIMITED are JITENDRA ... and DILIP ..."
  const bodyText = $('body').text().replace(/\s+/g, ' ');
  const m = bodyText.match(/Directors?\s+of\s+.{0,120}?\s+(?:are|is)\s+([^.]{4,400})\./i);
  if (m) {
    for (const part of m[1].split(/,|\band\b|&/i)) {
      push(part, 'Director', '');
    }
  }
  return [...found.values()];
}

/**
 * Recover explicitly named registry directors from indexed search evidence.
 * Company summaries take priority; director pages need a current association
 * row naming this company and the person's role. A name or company mention
 * alone is not enough, and past association sections are never accepted.
 */
function parseDirectorsFromSearchResults(results, companyName) {
  const companyTokens = companyTokensOf(companyName);
  const found = new Map();
  const plain = (text) => cheerio.load(String(text || '')).text().replace(/\s+/g, ' ').trim();
  const push = (rawName, designation, din, appointmentDate, sourceUrl) => {
    const name = cleanName(rawName);
    if (!isValidPersonName(name, { companyTokens })) return;
    const key = nameKey(name);
    if (!key || found.has(key)) return;
    found.set(key, {
      name, designation, din: din || null, appointmentDate: appointmentDate || null,
      source: ZAUBA_SEARCH_SOURCE, sourceUrl,
    });
  };

  for (const result of results) {
    const company = parseCompanyUrl(result.url);
    if (!company || !matchCompanyName(companyName, company.nameFromSlug).accepted) continue;
    // Removing dots from initials keeps "K. Krithivasan" inside the sentence.
    const text = plain(result.snippet).replace(/\b([A-Z])\./g, '$1');
    const statements = [...text.matchAll(/\bDirectors?\s+of\s+(.{2,150}?)\s+(?:are|is)\s+([^.;]{4,400})[.;]/gi)];
    for (const match of statements) {
      const prefix = text.slice(Math.max(0, match.index - 30), match.index);
      if (/\b(?:past|former|previous|resigned)\s*$/i.test(prefix)) continue;
      if (!matchCompanyName(companyName, match[1]).accepted) continue;
      for (const name of match[2].split(/,|\band\b|&/i)) {
        push(name, 'Director', '', '', result.url);
      }
    }
  }

  for (const result of results) {
    let url;
    try { url = new URL(result.url); } catch { continue; }
    if (url.hostname.replace(/^www\./i, '').toLowerCase() !== 'zaubacorp.com') continue;
    const path = url.pathname.match(/^\/([A-Za-z0-9'.%\-]+)-(\d{8})\/?$/) ||
      url.pathname.match(/^\/director\/([A-Za-z0-9'.%\-]+)\/(\d{8})\/?$/i);
    if (!path) continue;
    let slugName;
    try { slugName = decodeURIComponent(path[1]).replace(/-+/g, ' ').toUpperCase(); } catch { continue; }
    const name = cleanName(plain(result.title).replace(/\s*[|–—]\s*ZaubaCorp.*$/i, '').trim());
    // Both the page title and its DIN URL must identify the same person.
    if (!name || nameKey(name) !== nameKey(slugName)) continue;

    const text = plain(result.snippet);
    const active = text.split(/\b(?:past|former|previous)\s+(?:companies|directorships|appointments)\b/i)[0];
    const heading = /\b(?:current\s+)?companies\s+associated\s+with\b/i.exec(active);
    if (!heading) continue;
    const associations = active.slice(heading.index + heading[0].length).replace(/^[\s:;,]+/, '');
    for (const row of associations.split(/\s*[;|]\s*/)) {
      if (/\b(?:past|former|resigned|ceased|cessation)\b/i.test(row)) continue;
      const cells = row.split(/\s*,\s*/);
      if (cells.length < 2 || !matchCompanyName(companyName, cells[0]).accepted) continue;
      const designation = cells[1].trim();
      if (designation.length > 60 || !/\b(?:director|designated partner)\b/i.test(designation)) continue;
      const date = (cells[2] || '').trim();
      const appointmentDate = /^\d{1,2}[-/](?:\d{1,2}|[A-Za-z]{3,9})[-/]\d{4}$/.test(date) ? date : '';
      push(name, tidyZaubaDesignation(designation), path[2], appointmentDate, result.url);
    }
  }
  return [...found.values()];
}

/* ------------------------------------------------------------------ *
 * Public entry point: directors from ZaubaCorp
 * ------------------------------------------------------------------ */

/**
 * Look the company up on ZaubaCorp and return its current directors.
 *
 * Never throws. Always returns
 *   { ok, directors, pageUrl, matchedName, confidence, reason }
 * where `reason` states exactly why nothing came back:
 *   'ZaubaCorp page not found' | 'Company match confidence too low'
 *   | 'Directors unavailable' | 'ZaubaCorp page could not be loaded'
 */
async function findDirectorsOnZaubaCorp(companyName, log = () => {}) {
  const fail = (reason, extra = {}) => ({
    ok: false,
    directors: [],
    pageUrl: null,
    matchedName: null,
    confidence: 'none',
    reason,
    ...extra,
  });

  try {
    log('ZaubaCorp fallback: searching company registry...');

    const { candidates, results: searchResults } = await searchZaubaCandidates(companyName, log);
    log(`  ${candidates.length} ZaubaCorp page candidate(s) from web search`);

    let best = pickBestCandidate(companyName, candidates, log);
    let anyCandidate = candidates.length > 0;

    if (!best) {
      const direct = await searchZaubaDirectly(companyName, log);
      if (direct.length) {
        log(`  ${direct.length} candidate(s) from ZaubaCorp site search`);
        anyCandidate = true;
        best = pickBestCandidate(companyName, direct, log);
      }
    }

    if (!best) {
      return fail(anyCandidate ? 'Company match confidence too low' : 'ZaubaCorp page not found');
    }

    log(
      `  matched "${best.candidateName}" (${best.match.confidence} confidence, ` +
        `score ${best.match.score}) -> ${best.url}`
    );

    const pageUrl = `${best.url}${DIRECTOR_SECTION}`;
    let html = null;
    try { html = await loadZaubaHtml(pageUrl, log, { directors: true }); } catch (err) {
      log(`    ZaubaCorp page could not be loaded: ${err.message}`);
    }

    let directors = html ? parseDirectorsFromHtml(html, companyName) : [];
    const hasDirectorSection = Boolean(html && cheerio.load(html)(DIRECTOR_SECTION).length);
    // An explicitly present empty Directors section remains authoritative.
    // Indexed snippets are a recovery path only when the page/section is absent.
    if (!directors.length && !hasDirectorSection) {
      log('    checking indexed ZaubaCorp results for explicit director names');
      directors = parseDirectorsFromSearchResults(searchResults, companyName);
      if (!directors.length) {
        const extraResults = await searchWithFallbackQueries(
          () => [`site:zaubacorp.com "${best.altName || companyName}" "Director"`],
          { log, accept: (r) => parseDirectorsFromSearchResults([r], companyName).length > 0, minAccepted: 1 }
        );
        directors = parseDirectorsFromSearchResults(extraResults, companyName);
      }
    }
    if (!directors.length) {
      return fail(html ? 'Directors unavailable' : 'ZaubaCorp page could not be loaded; indexed results did not identify directors', {
        pageUrl,
        matchedName: best.candidateName,
        confidence: best.match.confidence,
      });
    }

    const fromSearch = directors.some((director) => director.source === ZAUBA_SEARCH_SOURCE);
    log(fromSearch
      ? `  ZaubaCorp search results identified ${directors.length} director(s); source links retained`
      : `  ZaubaCorp listed ${directors.length} current director(s)`);
    return {
      ok: true,
      directors: directors.map((d) => ({ ...d, companyName })),
      pageUrl,
      matchedName: best.candidateName,
      confidence: best.match.confidence,
      reason: '',
    };
  } catch (err) {
    return fail(`ZaubaCorp lookup error: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * LinkedIn verification for ZaubaCorp names
 *
 * Registry names are authoritative about the company but say nothing about
 * which "Jitendra Shah" on LinkedIn is the right one, so the bar here is
 * deliberately higher than the generic lookup: the employer must show up in
 * the evidence, or the profile is rejected.
 * ------------------------------------------------------------------ */

const LINKEDIN_MATCH_THRESHOLD = 10;

// Google is the best source of registry-name profiles, but a self-hosted
// SearXNG scraping it from one address draws a CAPTCHA within a few dozen
// queries, and a suspended engine returns an empty set that reads as "no such
// person". Bing rides along so a blocked Google degrades the results instead
// of emptying them; SearXNG merges whichever engines answer.
const LINKEDIN_SEARCH_ENGINES = 'google,bing';

/** Company evidence in a result, split by where it was found. */
function companyEvidence(result, companyName) {
  const tokens = [...new Set(normalizedTokens(companyName))]
    .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
  if (!tokens.length) return { inTitle: false, inSnippet: false, tokens };

  const matches = (text) => {
    const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singularize);
    const compact = words.join('');
    // A shared word such as "Foods" must not tie an unrelated employer to
    // this company, especially when a name-only result came from the cache.
    return tokens.every((token) => words.includes(token)) || compact.includes(tokens.join(''));
  };

  return {
    tokens,
    inTitle: matches(result.title) || matches(result.url),
    inSnippet: matches(result.snippet),
  };
}

/**
 * Verify one ZaubaCorp director on LinkedIn.
 *
 * Returns { url, confidence, reason }:
 *   high   - name matches AND the company is in the profile title / URL
 *   medium - name matches AND the company appears in the surrounding profile
 *            information (snippet)
 *   none   - no result proved BOTH the person and the employer
 */
async function verifyDirectorOnLinkedIn(personName, companyName, designation, log = () => {}) {
  const brand = brandTokens(companyName).join(' ') || companyName;
  const role = designation || 'Director';
  const name = cleanName(personName).replace(/\s+/g, ' ').trim();
  const parts = name.split(' ');
  // Registry names often include a middle/patronymic name that is absent
  // from LinkedIn. Search both forms; keep the original name for validation.
  const shortName = parts.length > 2 ? `${parts[0]} ${parts.at(-1)}` : name;
  const names = [...new Set([name, shortName])];

  const queries = [
    // Start with the same broad search a person would type into Google.
    ...names.map((n) => `${companyName.trim()} ${n}`),
    ...names.map((n) => `${brand} ${n} LinkedIn`),
    ...names.map((n) => `site:linkedin.com/in "${n}" "${brand}"`),
    ...names.map((n) => `site:linkedin.com/in ${n} ${brand}`),
    `"${shortName}" ${brand} ${role} LinkedIn`,
    `"${shortName}" "${companyName}" LinkedIn`,
    // A name-only search can surface Experience snippets omitted by a
    // company-scoped query. Acceptance still requires employer evidence.
    ...names.map((n) => `site:linkedin.com/in "${n}"`),
  ];

  const score = (r) => validateLinkedInCandidate(r.url, r.title, personName, companyName, r.snippet);
  const accept = (r) => {
    if (!isPersonalProfileUrl(r.url)) return false;
    if (score(r) < LINKEDIN_MATCH_THRESHOLD) {
      return false;
    }
    const evidence = companyEvidence(r, companyName);
    return evidence.inTitle || evidence.inSnippet;
  };

  const results = await searchWithFallbackQueries(() => queries, {
    accept,
    minAccepted: 1,
    searxngEngines: LINKEDIN_SEARCH_ENGINES,
    log,
  });

  const profiles = results.filter((r) => isPersonalProfileUrl(r.url));
  log(`    ${results.length} result(s), ${profiles.length} personal profile(s)`);
  if (!profiles.length) {
    return {
      url: null,
      confidence: 'none',
      reason: 'LinkedIn verification failed: no profile in results',
    };
  }

  const scored = profiles
    .map((r) => ({
      ...r,
      score: score(r),
      evidence: companyEvidence(r, companyName),
    }))
    // Title evidence outranks snippet evidence at equal name confidence.
    .sort(
      (a, b) => Number(b.evidence.inTitle) - Number(a.evidence.inTitle) || b.score - a.score
    );

  for (const cand of scored) {
    if (cand.score < LINKEDIN_MATCH_THRESHOLD) continue;
    if (cand.evidence.inTitle) {
      log(`    verified (high, score ${cand.score}): ${cand.url}`);
      return { url: cand.url, confidence: 'high', reason: '' };
    }
    if (cand.evidence.inSnippet) {
      log(`    verified (medium, score ${cand.score}): ${cand.url}`);
      return { url: cand.url, confidence: 'medium', reason: '' };
    }
  }

  // Something scored on the name alone but nothing tied it to this company —
  // exactly the "different person, same name" case the report must not carry.
  const bestName = scored[0];
  const why =
    bestName && bestName.score >= LINKEDIN_MATCH_THRESHOLD
      ? 'LinkedIn verification failed: name matched but company did not'
      : 'LinkedIn verification failed: no confident name match';
  log(`    ${why}`);
  return { url: null, confidence: 'none', reason: why };
}

module.exports = {
  ZAUBA_SOURCE,
  WEBSITE_SOURCE,
  findDirectorsOnZaubaCorp,
  verifyDirectorOnLinkedIn,
  closeZaubaBrowser,
  // exported for tests / reuse
  matchCompanyName,
  companyNameSimilarity,
  normalizedTokens,
  parseCompanyUrl,
  parseDirectorsFromHtml,
  parseDirectorsFromSearchResults,
  openDirectorInformation,
  tidyZaubaDesignation,
};
