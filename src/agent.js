/**
 * Orchestrator: for each company -> discover website -> crawl for leaders
 * -> find LinkedIn per person. Emits progress events to a job logger.
 */

const {
  searchWeb,
  searchWithFallbackQueries,
  closeSearchBrowser,
  verifySearchProvider,
} = require('./search');
const { withSearchConfig, currentSearchConfig, searchProviderLabel, noteSearchProvider } = require('./search-config');
const { findOfficialWebsiteWithQueries } = require('./discover');
const { crawlWebsiteForLeaders } = require('./crawler');
const { extractLeaders } = require('./extract');
const { findLinkedInProfile, hasCompanyEvidence, isPersonalProfileUrl, validateLinkedInCandidate } = require('./linkedin');
const {
  findDirectorsOnZaubaCorp,
  verifyDirectorOnLinkedIn,
  closeZaubaBrowser,
  ZAUBA_SOURCE,
  WEBSITE_SOURCE,
} = require('./zaubacorp');
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
const LINKEDIN_SOURCE = 'LinkedIn Direct';
const SEARXNG_SOURCE = 'SearXNG';
const isSearchUnavailable = (error) => error?.code === 'SEARCH_UNAVAILABLE';
// A query can fail while other engines remain usable for the next person.
const isBlockingSearchUnavailable = (error) => isSearchUnavailable(error) && !error.retryWithRemainingEngines;

function cleanRegistrySourceUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (!/(^|\.)zaubacorp\.com$/i.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

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

/** Company-only uploads need names from actual profile cards, not the query. */
function directLeaderFromResult(result, companyName) {
  if (!isPersonalProfileUrl(result.url)) return null;
  const name = cleanName(result.name || String(result.title || '').split(/\s+[-\u2013\u2014|]\s+/)[0]);
  if (!isValidPersonName(name, { companyTokens: companyTokensOf(companyName) })) return null;
  if (validateLinkedInCandidate(result.url, result.title, name, companyName, result.snippet) < 10) return null;
  const evidence = [result.headline, result.title, result.snippet].filter(Boolean)
    .flatMap((text) => String(text).split(/[\r\n;|\u2022]+|\s+(?:and|&)\s+(?=[^;|,\n]{0,50}\bat\b)/i))
    .flatMap((line) => {
      const clauses = [];
      for (const part of line.split(',')) {
        const text = part.trim();
        const startsRole = /^(?:advisor|adviser|consultant)\b/i.test(text) ||
          findDesignations(text).some((match) => match.index === 0);
        // Keep "Managing Director, Acme" together. A comma starts a new
        // employment clause only when another role follows it.
        if (!clauses.length || startsRole) clauses.push(text);
        else clauses[clauses.length - 1] += `, ${text}`;
      }
      return clauses;
    });
  for (const line of evidence.filter(Boolean)) {
    // A past job or two different employers elsewhere on the card cannot
    // turn an unrelated person's current title into this company's director.
    if (/\b(former|formerly|previous|previously|past|retired|ex[-\s]|until|was|served as)\b/i.test(line)) continue;
    if (!hasCompanyEvidence({ title: line }, companyName)) continue;
    const role = findDesignations(line).find((match) => isSeniorDesignation(normalizeDesignation(match.match)));
    if (!role) continue;
    return { name, designation: normalizeDesignation(role.match), linkedinUrl: result.url };
  }
  return null;
}

/** Search LinkedIn Direct for each known name together with the company. */
async function directorsOnLinkedIn(people, companyName, job, log) {
  const rows = [];
  let unavailable = null;
  for (const person of people) {
    if (isCancelled(job)) break;
    let url = null;
    try {
      if (!unavailable) {
        const controller = new AbortController();
        const unregister = job.onCancel?.(() => controller.abort());
        try {
          url = await findLinkedInProfile(person.name, companyName, person.designation, log, { signal: controller.signal });
        } finally { unregister?.(); }
      }
    } catch (err) {
      if (isCancelled(job)) return rows;
      if (!isSearchUnavailable(err)) throw err;
      unavailable = err;
      log(`LinkedIn Direct: ${err.message}`);
    }
    const discovered = Boolean(person.source);
    rows.push({ companyName, personName: person.name, designation: person.designation || null,
      linkedinUrl: url,
      ...(person.din ? { din: person.din } : {}),
      ...(person.appointmentDate ? { appointmentDate: person.appointmentDate } : {}),
      sourceUrl: discovered ? person.sourceUrl || url : url,
      source: discovered ? person.source : LINKEDIN_SOURCE,
      status: url ? 'ok' : unavailable ? 'search_unavailable' : 'no_linkedin',
      ...(unavailable && !url ? { reason: unavailable.message } : {}) });
  }
  return rows;
}

/**
 * LinkedIn found nobody for a company-only row: look the director names up
 * through SearXNG (ZaubaCorp registry first, then web snippets). Never throws.
 */
async function directorNamesFromSearxng(companyName, log) {
  try {
    return await withSearchConfig({ provider: 'searxng' }, async () => {
      const zauba = await findDirectorsOnZaubaCorp(companyName, log);
      if (zauba.ok) {
        const pageUrl = cleanRegistrySourceUrl(zauba.pageUrl);
        return { directors: zauba.directors.map((d) => ({ ...d, source: d.source || ZAUBA_SOURCE,
          sourceUrl: d.sourceUrl || pageUrl })) };
      }
      log(`SearXNG: ZaubaCorp gave no director names (${zauba.reason}); checking search snippets`);
      try {
        const leaders = await leadersFromWebSnippets(companyName, log);
        return { directors: leaders.map((p) => ({ name: p.name, designation: p.designation, source: SEARXNG_SOURCE })),
          reason: zauba.reason, unavailable: zauba.errorCode === 'SEARCH_UNAVAILABLE' };
      } catch (err) {
        if (!isSearchUnavailable(err)) throw err;
        return { directors: [], reason: err.message, unavailable: true };
      }
    });
  } catch (err) {
    return { directors: [], reason: err.message, unavailable: true };
  }
}

async function processCompanyDirect(companyName, suppliedDirectors, job, log, nullRow) {
  const rows = [];
  if (suppliedDirectors.length) {
    log(`LinkedIn Direct: searching ${suppliedDirectors.length} supplied director name(s) with ${companyName}`);
    return directorsOnLinkedIn(suppliedDirectors, companyName, job, log);
  }
  log('LinkedIn Direct: no director names supplied; searching company and director roles on LinkedIn');
  try {
    const controller = new AbortController();
    const unregister = job.onCancel?.(() => controller.abort());
    let results;
    try {
      results = await require('./linkedin-direct').searchLinkedInDirect({ companyName, log,
        accept: (result) => Boolean(directLeaderFromResult(result, companyName)), signal: controller.signal });
    } finally { unregister?.(); }
    const seen = new Set();
    for (const result of results) {
      const person = directLeaderFromResult(result, companyName);
      if (!person || seen.has(nameKey(person.name))) continue;
      seen.add(nameKey(person.name));
      rows.push({ companyName, personName: person.name, designation: person.designation,
        linkedinUrl: person.linkedinUrl, sourceUrl: person.linkedinUrl, source: LINKEDIN_SOURCE, status: 'ok' });
    }
    log(`LinkedIn Direct: ${rows.length} profile(s) with company and senior-role evidence`);
    if (rows.length || isCancelled(job)) return rows;
  } catch (err) {
    if (isCancelled(job)) return rows;
    if (!isSearchUnavailable(err)) throw err;
    log(`LinkedIn Direct: ${err.message}`);
    return nullRow('search_unavailable', LINKEDIN_SOURCE, err.message);
  }

  log('LinkedIn Direct: no director found -> finding director names with SearXNG');
  const found = await directorNamesFromSearxng(companyName, log);
  if (isCancelled(job)) return rows;
  const seen = new Set();
  const directors = found.directors.filter((person) => {
    const key = nameKey(person.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_PEOPLE_PER_COMPANY);
  if (!directors.length) {
    log(`SearXNG: no director names found${found.reason ? ` (${found.reason})` : ''}`);
    return found.unavailable
      ? nullRow('search_unavailable', SEARXNG_SOURCE, `LinkedIn found no director, and SearXNG could not look up director names: ${found.reason}`)
      : nullRow('linkedin_unverified', LINKEDIN_SOURCE,
        'Neither LinkedIn nor SearXNG identified a named director at this company. Add a Director Name column to search known directors.');
  }
  log(`SearXNG found ${directors.length} director name(s); searching each with ${companyName} on LinkedIn`);
  return directorsOnLinkedIn(directors, companyName, job, log);
}

/**
 * ZaubaCorp reports why it gave up in words; the report stores a status code.
 * Every failure mode maps to its own code so a NULL row always explains
 * itself rather than looking like a generic miss.
 */
function zaubaStatusFor(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('page not found')) return 'zauba_not_found';
  if (r.includes('confidence too low')) return 'zauba_low_confidence';
  if (r.includes('directors unavailable')) return 'zauba_no_directors';
  if (r.includes('could not be loaded')) return 'zauba_unreachable';
  return 'zauba_error';
}

/**
 * Use registry names when the official website is missing, no directors are
 * named, or a director's LinkedIn lookup failed. Search each registry name
 * together with the company, then validate the returned profile URL.
 */
async function directorsFromZaubaCorp(companyName, log, nullRow) {
  const zauba = await findDirectorsOnZaubaCorp(companyName, log);

  if (!zauba.ok) {
    log(`ZaubaCorp fallback failed: ${zauba.reason}`);
    const rows = zauba.errorCode === 'SEARCH_UNAVAILABLE'
      ? nullRow('search_unavailable', ZAUBA_SOURCE, zauba.reason)
      : nullRow(zaubaStatusFor(zauba.reason), ZAUBA_SOURCE);
    const sourceUrl = cleanRegistrySourceUrl(zauba.pageUrl);
    return sourceUrl ? rows.map((row) => ({ ...row, sourceUrl })) : rows;
  }

  log(
    `ZaubaCorp matched "${zauba.matchedName}" (${zauba.confidence} confidence); ` +
      `verifying ${zauba.directors.length} director(s) on LinkedIn`
  );

  const rows = [];
  let searchUnavailable = null;
  for (const person of zauba.directors) {
    const designation = person.designation || 'Director';
    log(`verifying ${person.name} (${designation}) on LinkedIn`);

    let verdict = { url: null, confidence: 'none', reason: 'LinkedIn verification failed' };
    let personSearchUnavailable = searchUnavailable;
    try {
      if (!searchUnavailable) verdict = await verifyDirectorOnLinkedIn(person.name, companyName, designation, log, { matchedCompanyName: zauba.matchedName });
    } catch (err) {
      if (isSearchUnavailable(err)) personSearchUnavailable = err;
      if (isBlockingSearchUnavailable(err)) searchUnavailable = err;
      verdict = {
        url: null,
        confidence: 'none',
        reason: `LinkedIn verification failed: ${err.message}`,
      };
      log(`LinkedIn verification error: ${err.message}`);
    }

    let status = personSearchUnavailable ? 'search_unavailable' : 'linkedin_unverified';
    if (verdict.url) status = verdict.confidence === 'medium' ? 'ok_medium' : 'ok';

    rows.push({
      companyName,
      personName: person.name,
      designation,
      linkedinUrl: verdict.url,
      din: person.din || null,
      appointmentDate: person.appointmentDate || null,
      sourceUrl: person.sourceUrl || zauba.pageUrl || null,
      status,
      source: person.source || ZAUBA_SOURCE,
      ...(personSearchUnavailable && !verdict.url ? { reason: personSearchUnavailable.message } : {}),
    });
  }
  return rows;
}

/** Enrich missing matches without dropping website results or duplicating people. */
function mergeDirectorRows(rows, registryRows) {
  const unavailable = registryRows.find((row) => !row.personName && row.status === 'search_unavailable');
  const merged = rows.map((row) => !row.linkedinUrl && unavailable
    ? { ...row, status: 'search_unavailable', reason: unavailable.reason,
      ...(unavailable.sourceUrl && !row.sourceUrl ? { sourceUrl: unavailable.sourceUrl } : {}) }
    : row);
  for (const registry of registryRows) {
    if (!registry.personName) continue;
    const index = merged.findIndex((row) =>
      nameKey(row.personName) === nameKey(registry.personName) ||
      (row.linkedinUrl && row.linkedinUrl === registry.linkedinUrl));
    if (index === -1) {
      merged.push(registry);
      continue;
    }
    const previous = merged[index];
    const linkedinUrl = previous.linkedinUrl || registry.linkedinUrl;
    const incomplete = registry.status === 'search_unavailable' ? registry
      : previous.status === 'search_unavailable' ? previous : null;
    merged[index] = {
      ...previous,
      ...registry,
      linkedinUrl,
      status: previous.linkedinUrl ? previous.status : linkedinUrl ? registry.status : incomplete?.status || registry.status,
      source: previous.linkedinUrl ? previous.source : registry.source,
    };
    if (linkedinUrl) delete merged[index].reason;
    else if (incomplete?.reason) merged[index].reason = incomplete.reason;
  }
  return merged;
}

/**
 * Cooperative cancellation. The job object owns the flag; the agent only ever
 * reads it, so a cancelled run stops at a clean boundary (between companies,
 * or between the per-person LinkedIn lookups) instead of being killed
 * mid-write and losing the rows already collected.
 */
function isCancelled(job) {
  return Boolean(job.cancelled);
}

/**
 * Human-like pacing between companies, cut short by a cancel: waiting out a
 * three-second sleep after the user asked to stop just looks broken.
 */
function pauseBetweenCompanies(job) {
  return new Promise((resolve) => {
    let unregister = null;
    const timer = setTimeout(finish, 1500 + Math.random() * 2000);
    function finish() {
      clearTimeout(timer);
      // Drop the waiter on the normal path too, so a long company list does
      // not leave one dead callback per company on the job.
      if (unregister) unregister();
      resolve();
    }
    unregister = job.onCancel?.(finish) ?? null;
  });
}

async function processCompany(companyInput, job) {
  const companyName = typeof companyInput === 'string' ? companyInput : companyInput.companyName;
  const suppliedDirectors = typeof companyInput === 'string' ? [] : companyInput.directors || [];
  const log = (msg) => job.log(`[${companyName}] ${msg}`);
  const nullRow = (status, source = WEBSITE_SOURCE, reason = null) => [{
    companyName,
    personName: null,
    designation: null,
    linkedinUrl: null,
    status,
    source,
    ...(reason ? { reason } : {}),
  }];

  try {
    if (currentSearchConfig().provider === 'linkedin') {
      return await processCompanyDirect(companyName, suppliedDirectors, job, log, nullRow);
    }
    // Step 1: discover official website (retry with different queries)
    log('searching for official website...');
    // Quote the brand (without the "Pvt Ltd" tail, which pages rarely print):
    // unquoted, a throttled engine happily answers "Tata Consultancy Services"
    // with Tata Motors pages.
    const brand = brandTokens(companyName).join(' ') || companyName;
    let discoveryError = null;
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
    ).catch((err) => {
      if (!isSearchUnavailable(err)) throw err;
      discoveryError = err;
      log(`official website search unavailable: ${err.message}; trying ZaubaCorp directly`);
      return null;
    });

    let leaders = [];
    let searchUnavailable = null;
    let registryRows = null;
    // One registry lookup per company, even when later fallbacks also miss.
    const lookupRegistry = async () => {
      if (!registryRows) registryRows = await directorsFromZaubaCorp(companyName, log, nullRow);
      return registryRows;
    };

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
      log('official website not found -> ZaubaCorp director-name fallback');
      const rows = await lookupRegistry();
      if (rows.some((row) => row.personName || row.status === 'search_unavailable')) return rows;
      if (discoveryError) return nullRow('search_unavailable', ZAUBA_SOURCE, discoveryError.message);
      log('ZaubaCorp directors unavailable -> trying LinkedIn search fallbacks');
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
      try {
        const fromLinkedIn = await leadersFromLinkedInTitles(companyName, log);
        log(`fallback found ${fromLinkedIn.length} candidate(s) from LinkedIn titles`);
        merge(fromLinkedIn);
      } catch (err) {
        if (!isSearchUnavailable(err)) throw err;
        searchUnavailable = err;
        log(`search temporarily unavailable: ${err.message}`);
      }
    }

    // Fallback 2: mine ordinary web results for "Name, Title" mentions.
    // Gated on titled people for the same reason as fallback 1.
    if (titledCount() === 0 && !isBlockingSearchUnavailable(searchUnavailable)) {
      try {
        merge(await leadersFromWebSnippets(companyName, log));
      } catch (err) {
        if (!isSearchUnavailable(err)) throw err;
        searchUnavailable = err;
        log(`search temporarily unavailable: ${err.message}`);
      }
    }

    // Registry names also cover a website that never names its directors.
    if (leaders.length === 0) {
      if (isBlockingSearchUnavailable(searchUnavailable)) return nullRow('search_unavailable', WEBSITE_SOURCE, searchUnavailable.message);
      log(
        website
          ? 'website found but no directors extracted -> ZaubaCorp fallback'
          : 'official website not found -> ZaubaCorp fallback'
      );
      const rows = await lookupRegistry();
      if (searchUnavailable && !rows.some((row) => row.personName || row.status === 'search_unavailable')) {
        return nullRow('search_unavailable', WEBSITE_SOURCE, searchUnavailable.message);
      }
      return rows;
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
      if (isCancelled(job)) {
        log('cancelled - keeping the rows found so far');
        break;
      }
      const designation = person.designation || 'Director';
      let url = person.linkedinUrl || null;
      let personSearchUnavailable = isBlockingSearchUnavailable(searchUnavailable) ? searchUnavailable : null;

      if (!url && !personSearchUnavailable) {
        log(`finding LinkedIn for ${person.name} (${designation})`);
        try {
          url = await findLinkedInProfile(person.name, companyName, designation, log);
        } catch (err) {
          if (isSearchUnavailable(err)) personSearchUnavailable = err;
          if (isBlockingSearchUnavailable(err)) searchUnavailable = err;
          log(`LinkedIn lookup failed: ${err.message}`);
        }
      }

      rows.push({
        companyName,
        personName: person.name,
        designation,
        linkedinUrl: url,
        status: url ? 'ok' : personSearchUnavailable ? 'search_unavailable' : 'no_linkedin',
        source: WEBSITE_SOURCE,
        ...(personSearchUnavailable && !url ? { reason: personSearchUnavailable.message } : {}),
      });
    }
    if (!isBlockingSearchUnavailable(searchUnavailable) && !isCancelled(job) && rows.some((row) => !row.linkedinUrl)) {
      log('director LinkedIn URL missing -> ZaubaCorp director-name fallback');
      return mergeDirectorRows(rows, await lookupRegistry());
    }
    return rows;
  } catch (err) {
    if (isSearchUnavailable(err)) {
      log(`search temporarily unavailable: ${err.message}`);
      return nullRow('search_unavailable', WEBSITE_SOURCE, err.message);
    }
    log(`unexpected error: ${err.message} -> NULL row`);
    return nullRow('error');
  }
}

/**
 * Process the full company list sequentially with human-like pacing.
 * Calls job.onRow(row) as each final row is produced.
 */
function runAgent(companies, job, searchOptions = {}) {
  return withSearchConfig(searchOptions, () => runAgentWithProvider(companies, job));
}

async function runAgentWithProvider(companies, job) {
  const provider = currentSearchConfig().provider;
  const useLlm = provider !== 'linkedin' && llmEnabled();
  job.log(`LLM layer: ${useLlm ? 'ENABLED' : 'disabled (heuristic mode)'}`);

  // Prove the search backend works before spending an hour discovering it
  // doesn't. A dead backend is the difference between a full report and a
  // sheet of NULLs, so it is worth saying so loudly and up front.
  const check = await verifySearchProvider();
  if (check.ok) {
    const warnings = check.warnings || [];
    job.log(`Search: ${searchProviderLabel()} ${warnings.length ? 'connected with limited engines' : 'OK'}${check.credits == null ? '' : ` — ${check.credits} credits left`}`);
    if (warnings.length) job.log(`Search engine availability: ${warnings.join('; ')}`);
  } else if (provider === 'linkedin') {
    throw new Error(`LinkedIn Direct is not connected: ${check.error}`);
  } else if (provider === 'own') {
    throw new Error(`Own Search connection failed: ${check.error}`);
  } else if (provider === 'searxng') {
    throw new Error(`SearXNG connection failed: ${check.error}`);
  } else if (['serpapi', 'hybrid'].includes(provider)) {
    throw new Error(`${provider === 'hybrid' ? 'SerpApi + SearXNG' : 'SerpApi'} connection failed: ${check.error}`);
  } else {
    job.log(`!! Serper unavailable: ${check.error}. Using scraped fallback engines.`);
    noteSearchProvider('scraped engines');
  }

  job.setMeta({
    total: companies.length,
    llmEnabled: useLlm,
    searchProvider: searchProviderLabel(),
  });

  const allRows = [];
  try {
    for (let i = 0; i < companies.length; i++) {
      if (isCancelled(job)) {
        job.log(`Cancelled - stopped after ${i} of ${companies.length} companies`);
        break;
      }
      const company = companies[i];
      job.setProgress({ current: i + 1, completed: i, company: typeof company === 'string' ? company : company.companyName });
      const rows = await processCompany(company, job);
      for (const r of rows) {
        allRows.push(r);
        job.onRow(r);
      }
      job.setProgress({ current: i + 1, completed: i + 1, company: null });
      // Pace only between companies; the final result can finish immediately.
      if (i < companies.length - 1 && !isCancelled(job)) {
        await pauseBetweenCompanies(job);
      }
    }
  } finally {
    job.setMeta({ searchProvider: searchProviderLabel() });
    await closeSearchBrowser();
    await closeZaubaBrowser();
  }

  return allRows;
}

module.exports = { runAgent };
