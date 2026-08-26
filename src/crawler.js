/**
 * Playwright-based human-like crawler.
 * Opens the official site, scrolls (handles lazy-loading / JS rendering),
 * dynamically discovers leadership pages (About Us, Our Team, Board, etc.),
 * and extracts director-level people without fixed selectors.
 *
 * Name/designation parsing lives in extract.js + person.js.
 */

const { chromium } = require('playwright');
const { extractLeaders, extractPageText } = require('./extract');
const { nameKey, betterDesignation } = require('./person');
const { extractLeadersWithLlm } = require('./llm');

const LEADERSHIP_LINK_KEYWORDS = [
  'board of directors', 'board members', 'management team', 'leadership team',
  'executive team', 'senior management', 'key management', 'our leadership',
  'meet the team', 'our people', 'our team', 'leadership', 'management',
  'directors', 'director', 'board', 'our leaders', 'leaders', 'founders',
  'founder', 'executives', 'corporate governance', 'governance', 'people',
  'who we are', 'about us', 'about company', 'company profile', 'about',
  'team', 'chairman', 'management council', 'administration', 'profile',
];

// Link text that looks relevant but never carries leadership info.
// "Heritage"/"History" pages list founders who died decades ago, so they are
// excluded alongside the obvious non-leadership sections.
const LINK_TEXT_EXCLUDE = /\b(privacy|cookie|terms|sitemap|login|careers?|jobs?|blog|news|events?|gallery|investor\s+relations|annual\s+report|downloads?|heritage|history|legacy|code\s+of\s+conduct|values|purpose|csr|sustainability|awards?|milestones?|timeline)\b/i;

const MAX_SUBPAGES = 5;
const PAGE_TIMEOUT = 45000;
const MAX_LEADERS = 12;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
}

async function newHumanContext(browser) {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: rand(1280, 1440), height: rand(760, 900) },
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  return context;
}

/** Human-like scroll to bottom in steps (triggers lazy loading). */
async function scrollPage(page) {
  try {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const step = () => {
          const distance = 300 + Math.floor(Math.random() * 300);
          window.scrollBy(0, distance);
          total += distance;
          if (total >= document.body.scrollHeight || total > 25000) resolve();
          else setTimeout(step, 150 + Math.random() * 200);
        };
        step();
        setTimeout(resolve, 12000); // hard cap
      });
      window.scrollTo(0, document.body.scrollHeight);
    });
  } catch { /* navigation raced the scroll */ }
  await sleep(rand(600, 1200));
}

/**
 * `requireOk` is for URLs we guessed: a 404 there means the path does not
 * exist. Real links and homepages are accepted regardless of status, because
 * plenty of sites serve usable HTML behind a 403 from their WAF.
 */
async function safeGoto(page, url, timeout = PAGE_TIMEOUT, { requireOk = false } = {}) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (requireOk && resp && resp.status() >= 400) return false;
    await sleep(rand(800, 1600));
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch { /* busy sites never go idle */ }
    return true;
  } catch {
    return false;
  }
}

// Bot walls serve a tiny page with one of these phrases instead of the site.
const BLOCK_PHRASES = /(access denied|you don'?t have permission|attention required|just a moment|checking your browser|enable javascript and cookies|request blocked|403 forbidden|unusual traffic)/i;

/** Did we get the real site, or a bot wall / empty shell? */
async function pageLooksBlocked(page) {
  try {
    const info = await page.evaluate(() => ({
      text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim(),
      links: document.querySelectorAll('a').length,
    }));
    if (!info.text) return true;
    if (info.text.length < 500 && BLOCK_PHRASES.test(info.text)) return true;
    return info.text.length < 200 && info.links === 0;
  } catch {
    return true;
  }
}

/** Expand hidden menus / accordions that may hold leadership links. */
async function expandHiddenMenus(page) {
  try {
    const handles = await page.$$('nav a, nav button, nav span, header a, header button');
    const limit = Math.min(handles.length, 60);
    for (let i = 0; i < limit; i += 1) {
      try {
        if (!(await handles[i].isVisible())) continue;
        await handles[i].hover({ timeout: 400 });
        await sleep(50);
      } catch { /* ignore individual failures */ }
    }
  } catch { /* ignore */ }
}

/**
 * Collect candidate leadership links using keyword matching on link text +
 * href (dynamic — no fixed selectors). Lower score = more promising.
 */
async function findLeadershipLinks(page, baseUrl) {
  const base = new URL(baseUrl);
  const seen = new Set();
  const results = [];

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map((a) => ({
      href: a.getAttribute('href') || '',
      text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase(),
    }))
  );

  for (const { href, text } of links) {
    if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
    if (LINK_TEXT_EXCLUDE.test(text)) continue;

    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|zip|docx?|xlsx?|pptx?)$/i.test(u.pathname)) continue;

    u.hash = '';
    const clean = u.toString();
    if (seen.has(clean)) continue;
    if (LINK_TEXT_EXCLUDE.test(u.pathname)) continue;

    const hay = `${text} ${u.pathname.toLowerCase()}`;
    const bestIdx = LEADERSHIP_LINK_KEYWORDS.findIndex((kw) => hay.includes(kw));
    if (bestIdx === -1) continue;

    const path = u.pathname.replace(/\/$/, '');
    const isHome = path === '' || /^\/index\.(php|html?)$/.test(path);
    if (isHome) continue; // already crawled

    seen.add(clean);
    results.push({ url: clean, text: text.slice(0, 80), score: bestIdx });
  }

  results.sort((a, b) => a.score - b.score);
  return results.slice(0, MAX_SUBPAGES);
}

/**
 * Some homepages block or hang. Try the www/apex variants and, failing that,
 * jump straight to the paths that usually hold leadership info.
 */
const COMMON_LEADERSHIP_PATHS = [
  '/leadership', '/who-we-are/leadership', '/about-us/leadership',
  '/about/leadership', '/company/leadership', '/our-team', '/team',
  '/about-us/our-team', '/management', '/management-team',
  '/board-of-directors', '/about-us/board-of-directors', '/our-leadership',
  '/about-us', '/about', '/who-we-are', '/investors/corporate-governance',
];

async function openHomepage(page, websiteUrl, log) {
  const u = new URL(websiteUrl);
  const host = u.hostname.replace(/^www\./, '');
  const variants = [
    websiteUrl,
    `https://www.${host}/`,
    `https://${host}/`,
    `http://www.${host}/`,
  ];

  for (const candidate of [...new Set(variants)]) {
    if (!(await safeGoto(page, candidate))) {
      log(`  could not open ${candidate}`);
      continue;
    }
    if (await pageLooksBlocked(page)) {
      log(`  ${candidate} served a bot wall / empty page`);
      continue;
    }
    return candidate;
  }

  for (const path of COMMON_LEADERSHIP_PATHS) {
    const candidate = `https://www.${host}${path}`;
    if (await safeGoto(page, candidate, 25000, { requireOk: true })) {
      log(`  homepage unreachable, entered via ${path}`);
      return candidate;
    }
  }
  return null;
}

/** Merge a page's candidates into the running map, accumulating confidence. */
function mergeLeaders(map, candidates, bonus = 0) {
  for (const p of candidates) {
    const key = nameKey(p.name);
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...p, score: p.score + bonus });
      continue;
    }
    prev.score += p.score + bonus;
    prev.designation = betterDesignation(prev.designation || '', p.designation || '');
    if (p.name.length > prev.name.length) prev.name = p.name;
  }
}

/**
 * Crawl a website end-to-end looking for directors.
 * Returns { leaders: [{name, designation, score}], pagesVisited: [..] }
 */
async function crawlWebsiteForLeaders(websiteUrl, companyName, log = () => {}) {
  const browser = await launchBrowser();
  const leadersMap = new Map();
  const pagesVisited = [];
  let homeText = '';
  let lastLeadershipHtml = '';
  // The page that actually yielded the most people — not merely the last one
  // visited, which is often a guessed path that 404'd into a template.
  let bestLeadershipHtml = '';
  let bestLeadershipCount = -1;

  try {
    const context = await newHumanContext(browser);
    const page = await context.newPage();
    // Don't waste time downloading images/fonts we never look at.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });

    log(`  opening ${websiteUrl}`);
    const opened = await openHomepage(page, websiteUrl, log);
    if (!opened) {
      log('  failed to open website');
      return { leaders: [], pagesVisited };
    }
    websiteUrl = opened;

    await expandHiddenMenus(page);
    await scrollPage(page);

    const html = await page.content();
    homeText = extractPageText(html);
    pagesVisited.push(websiteUrl);

    mergeLeaders(leadersMap, extractLeaders(html, companyName));
    log(`  homepage: ${leadersMap.size} candidate(s)`);

    let links = await findLeadershipLinks(page, websiteUrl);
    log(`  found ${links.length} potential leadership link(s)`);

    // Single-page-app navs often expose no crawlable <a> tags; guess the
    // conventional URLs instead of giving up on the company.
    if (links.length < 2) {
      const host = new URL(websiteUrl).hostname;
      const guessed = COMMON_LEADERSHIP_PATHS.slice(0, 8)
        .map((p) => ({ url: `https://${host}${p}`, text: `guess:${p}`, score: 99 }))
        .filter((g) => !links.some((l) => l.url.replace(/\/$/, '') === g.url));
      links = [...links, ...guessed];
      log(`  nav yielded little, probing ${guessed.length} conventional path(s)`);
    }

    for (const link of links) {
      if (pagesVisited.length > MAX_SUBPAGES) break;
      log(`  visiting: "${link.text}" -> ${link.url}`);
      const guessed = link.text.startsWith('guess:');
      if (!(await safeGoto(page, link.url, 35000, { requireOk: guessed }))) continue;
      pagesVisited.push(link.url);
      await scrollPage(page);

      const subHtml = await page.content();
      lastLeadershipHtml = subHtml;
      const found = extractLeaders(subHtml, companyName);
      // People named on a dedicated leadership page are more trustworthy.
      mergeLeaders(leadersMap, found, 2);
      log(`    -> ${found.length} candidate(s) on this page`);

      if (found.length > bestLeadershipCount) {
        bestLeadershipCount = found.length;
        bestLeadershipHtml = subHtml;
      }

      if (leadersMap.size >= MAX_LEADERS) break;
      await sleep(rand(1000, 2200));
    }

    // LLM pass whenever the structural rules came up thin. Requiring an
    // empty map meant a single junk candidate suppressed the one component
    // that can actually read an unusual layout.
    const titled = [...leadersMap.values()].filter((p) => p.designation).length;
    if (titled < 2) {
      const html = bestLeadershipHtml || lastLeadershipHtml;
      const text = html ? extractPageText(html) : homeText;
      log(`  only ${titled} titled candidate(s) -> LLM pass`);
      const llmResults = await extractLeadersWithLlm(text, companyName);
      if (llmResults && llmResults.length) {
        log(`  LLM extracted ${llmResults.length} candidate(s)`);
        mergeLeaders(
          leadersMap,
          llmResults.map((p) => ({ ...p, score: 3 }))
        );
      }
    }

    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }

  const all = [...leadersMap.values()].sort((a, b) => b.score - a.score);
  const titled = all.filter((p) => p.designation);
  // Prefer people with a stated title. Untitled names are a last resort —
  // better than a NULL row, but only when there is nothing to rank above them,
  // and only the strongest few, since that tier is where noise lives.
  const leaders = titled.length ? titled : all.slice(0, 3);
  return { leaders, pagesVisited };
}

module.exports = { crawlWebsiteForLeaders, findLeadershipLinks };
