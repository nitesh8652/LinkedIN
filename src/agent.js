/**
 * Orchestrator: for each company -> discover website -> crawl for leaders
 * -> find LinkedIn per person. Emits progress events to a job logger.
 */

const {
  searchWeb,
  searchWithFallbackQueries,
  closeSearchBrowser,
  serperStatus,
  verifySerperKey,
} = require('./search');
const { findOfficialWebsiteWithQueries } = require('./discover');
const { crawlWebsiteForLeaders } = require('./crawler');
const { extractLeaders } = require('./extract');
const { findLinkedInProfile } = require('./linkedin');
const { llmEnabled } = require('./llm');
const { brandTokens } = require('./normalize');
const {
  isValidPersonName,
  cleanName,
  normalizeDesignation,
  findDesignations,
  isSeniorDesignation,
  nameKey,
  companyTokensOf,
} = require('./person');

const MAX_PEOPLE_PER_COMPANY = 8;

/**
 * Last-resort discovery: read names straight out of LinkedIn search-result
 * titles ("Jane Doe - Managing Director - Acme | LinkedIn").
 */
async function leadersFromLinkedInTitles(companyName, log) {
  const companyTokens = companyTokensOf(companyName);
  const results = await searchWithFallbackQueries(
    () => [
      `site:linkedin.com/in "${companyName}" (director OR founder OR CEO OR chairman)`,
      `site:linkedin.com/in "${companyName}" "managing director"`,
      `site:linkedin.com/in "${companyName}" founder`,
    ],
    {
      accept: (r) => /linkedin\.com\/(in|pub)\//i.test(r.url),
      minAccepted: 4,
      log,
    }
  );

  const found = new Map();
  for (const r of results) {
    if (!/linkedin\.com\/(in|pub)\//i.test(r.url)) continue;

    const title = String(r.title || '');
    const context = `${title} ${r.snippet || ''}`;

    // The result must actually be about THIS company, not just any profile
    // the engine felt like returning.
    const lowerContext = context.toLowerCase();
    if (!companyTokens.some((t) => lowerContext.includes(t))) continue;

    // "Name - Title - Company | LinkedIn" (also en/em dashes and pipes)
    const parts = title
      .split(/\s+[-–—|]\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;

    const name = cleanName(parts[0]);
    if (!isValidPersonName(name, { companyTokens })) continue;

    // Only keep people whose role is actually stated somewhere.
    const roleText =
      parts.slice(1).find((p) => findDesignations(p).length) ||
      (findDesignations(r.snippet || '')[0] || {}).match ||
      '';
    const designation = normalizeDesignation(roleText);
    // A title is the only evidence here, so require a genuinely senior one.
    if (!designation || !isSeniorDesignation(designation)) continue;

    const key = nameKey(name);
    if (found.has(key)) continue;
    found.set(key, { name, designation, linkedinUrl: r.url, score: 2 });
  }
  return [...found.values()];
}

/**
 * When the official site is unreachable (bot wall, dead host), mine the
 * search results themselves: titles and snippets routinely read
 * "Jane Doe, Managing Director of Acme", which the HTML extractor already
 * knows how to parse once wrapped in markup.
 */
async function leadersFromWebSnippets(companyName, log) {
  const brand = brandTokens(companyName).join(' ') || companyName;
  const results = await searchWithFallbackQueries(
    () => [
      `"${brand}" "managing director" OR "chief executive officer"`,
      `"${brand}" board of directors names`,
      `"${brand}" leadership team chairman founder`,
    ],
    { minResults: 12, log }
  );

  const html = results
    .map((r) => `<p>${escapeHtml(r.title)}</p><p>${escapeHtml(r.snippet || '')}</p>`)
    .join('\n');
  if (!html.trim()) return [];

  const found = extractLeaders(`<html><body>${html}</body></html>`, companyName)
    .filter((p) => isSeniorDesignation(p.designation));
  log(`  ${found.length} candidate(s) from search snippets`);
  return found;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function processCompany(companyName, job) {
  const log = (msg) => job.log(`[${companyName}] ${msg}`);
  const nullRow = (status) => [{
    companyName,
    personName: null,
    designation: null,
    linkedinUrl: null,
    status,
  }];

  try {
    // Step 1: discover official website (retry with different queries)
    log('searching for official website...');
    // Quote the brand (without the "Pvt Ltd" tail, which pages rarely print):
    // unquoted, a throttled engine happily answers "Tata Consultancy Services"
    // with Tata Motors pages.
    const brand = brandTokens(companyName).join(' ') || companyName;
    const website = await findOfficialWebsiteWithQueries(
      companyName,
      [
        `"${brand}" official website`,
        `"${brand}" company official site`,
        `${companyName} official website`,
        `${companyName} homepage`,
      ],
      (q) => searchWeb(q, { log }),
      log
    );

    let leaders = [];

    if (website) {
      log(`official website: ${website.url}`);
      // Step 2: crawl for leadership info
      try {
        const crawled = await crawlWebsiteForLeaders(website.url, companyName, log);
        leaders = crawled.leaders;
        log(`extracted ${leaders.length} leadership candidate(s) from ${crawled.pagesVisited.length} page(s)`);
      } catch (err) {
        log(`crawl error (${err.message}) -> trying LinkedIn fallback`);
      }
    } else {
      log('official website not found -> trying LinkedIn fallback');
    }

    // The fallbacks used to be reachable only on a completely empty crawl, so
    // a site that yielded one junk name suppressed both. They now top up a
    // thin result instead of replacing it, deduped by name.
    const merge = (extra) => {
      const seen = new Set(leaders.map((p) => nameKey(p.name)));
      for (const p of extra) {
        const key = nameKey(p.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        leaders.push(p);
      }
    };

    // Fallback 1: pull names out of LinkedIn search-result titles. These
    // arrive with a linkedinUrl already attached, so they are the single most
    // valuable source in the pipeline and must not be gated behind a raw
    // count — a couple of untitled names off the homepage would suppress it.
    const titledCount = () => leaders.filter((p) => p.designation).length;
    if (titledCount() < 2) {
      const fromLinkedIn = await leadersFromLinkedInTitles(companyName, log);
      log(`fallback found ${fromLinkedIn.length} candidate(s) from LinkedIn titles`);
      merge(fromLinkedIn);
    }

    // Fallback 2: mine ordinary web results for "Name, Title" mentions.
    // Gated on titled people for the same reason as fallback 1.
    if (titledCount() === 0) {
      merge(await leadersFromWebSnippets(companyName, log));
    }

    if (leaders.length === 0) {
      log('directors not found -> NULL row');
      return nullRow(website ? 'no_directors' : 'no_website');
    }

    // Untitled names scraped off a homepage exist only to avoid an empty
    // report. Once real titled people have turned up they are pure noise, so
    // drop them rather than spending a lookup and a row on each.
    if (titledCount() > 0) leaders = leaders.filter((p) => p.designation);

    // Rank before truncating: someone who already has a LinkedIn URL is a
    // guaranteed row, someone with a stated title is a likely one, and an
    // untitled name off a homepage is the guess of last resort. Without this
    // the guesses take the 8 slots and push the certainties out.
    leaders.sort(
      (a, b) =>
        Number(Boolean(b.linkedinUrl)) - Number(Boolean(a.linkedinUrl)) ||
        Number(Boolean(b.designation)) - Number(Boolean(a.designation)) ||
        (b.score || 0) - (a.score || 0)
    );

    // Step 3: LinkedIn lookup per person
    const rows = [];
    for (const person of leaders.slice(0, MAX_PEOPLE_PER_COMPANY)) {
      const designation = person.designation || 'Director';
      let url = person.linkedinUrl || null;

      if (!url) {
        log(`finding LinkedIn for ${person.name} (${designation})`);
        try {
          url = await findLinkedInProfile(person.name, companyName, designation, log);
        } catch (err) {
          log(`LinkedIn lookup failed: ${err.message}`);
        }
      }

      rows.push({
        companyName,
        personName: person.name,
        designation,
        linkedinUrl: url,
        status: url ? 'ok' : 'no_linkedin',
      });
    }
    return rows;
  } catch (err) {
    log(`unexpected error: ${err.message} -> NULL row`);
    return nullRow('error');
  }
}

/**
 * Process the full company list sequentially with human-like pacing.
 * Calls job.onRow(row) as each final row is produced.
 */
async function runAgent(companies, job) {
  job.log(`LLM layer: ${llmEnabled() ? 'ENABLED' : 'disabled (heuristic mode)'}`);

  // Prove the search backend works before spending an hour discovering it
  // doesn't. A dead backend is the difference between a full report and a
  // sheet of NULLs, so it is worth saying so loudly and up front.
  const check = await verifySerperKey();
  if (check.ok) {
    job.log(`Search: Serper (Google API) OK${check.credits === null ? '' : ` — ${check.credits} credits left`}`);
  } else if (check.configured) {
    job.log(`!! Serper key REJECTED: ${check.error}`);
    job.log('!! Falling back to scraped engines, which are heavily throttled — expect mostly NULL rows.');
  } else {
    job.log('!! No SERPER_API_KEY set — using scraped engines only. Expect mostly NULL rows.');
  }

  const serper = serperStatus();
  job.setMeta({
    total: companies.length,
    llmEnabled: llmEnabled(),
    searchProvider: serper.active ? 'Serper (Google API)' : 'scraped engines (Serper unavailable)',
  });

  const allRows = [];
  try {
    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      job.setProgress({ current: i + 1, company });
      const rows = await processCompany(company, job);
      for (const r of rows) {
        allRows.push(r);
        job.onRow(r);
      }
      // human-like delay between companies
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
    }
  } finally {
    await closeSearchBrowser();
  }

  return allRows;
}

module.exports = { runAgent };
