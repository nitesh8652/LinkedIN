/**
 * Official website discovery: score search results to find the company's
 * official domain using regex-based matching (case-insensitive).
 */

const { brandTokens } = require('./normalize');

const SOCIAL_DOMAINS = [
  'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'youtube.com', 'wikipedia.org', 'glassdoor.com', 'indeed.com', 'justdial.com',
  'indiamart.com', 'tradeindia.com', 'amazon.', 'flipkart.com', 'google.com',
  'bloomberg.com', 'crunchbase.com', 'zoominfo.com', 'apollo.io', 'github.com',
  'reddit.com', 'quora.com', 'yelp.com', 'trustpilot.com', 'medium.com',
  'economictimes.', 'moneycontrol.com', 'naukri.com', 'shine.com', 'dnb.com',
  'zaubacorp.com', 'tofler.in', 'clear.tax', 'cacorporation', 'falconebiz.com',
  'thedirectory', 'yellowpages', 'sulekha.com', 'web.archive.org', 'archive.org',
  'pitchbook.com', 'owler.com', 'leadiq.com', 'rocketreach.co', 'signalhire.com',
  'zaubacorp', 'instafinancials.com', 'companycheck', 'opencorporates.com'
];

const BAD_TLDS_HINTS = ['pinterest.', 'slideshare'];

/**
 * Blocklist match against the hostname's labels.
 *
 * This used to be a substring test over the whole URL, which meant the entry
 * "x.com" silently discarded vertex.com, phoenix.com, onyx.com and xerox.com,
 * and "shine.com" discarded sunshine.com — each one an instant no_website row.
 */
function isSocialOrDirectory(url) {
  const host = getDomain(url);
  if (!host) return true;
  const labels = host.split('.');

  const matches = (entry) => {
    const d = entry.replace(/\.$/, '');
    // "linkedin.com" — the host itself or a subdomain of it.
    if (d.includes('.')) return host === d || host.endsWith(`.${d}`);
    // "amazon", "zaubacorp" — a whole label, never part of one.
    return labels.includes(d);
  };

  return SOCIAL_DOMAINS.some(matches) || BAD_TLDS_HINTS.some(matches);
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

// Public suffixes that are themselves two labels long.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.in', 'net.in', 'org.in', 'gen.in', 'ind.in', 'firm.in', 'ac.in', 'gov.in',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'com.sg', 'com.my', 'com.cn', 'com.br', 'com.mx', 'co.za', 'co.nz',
  'co.jp', 'co.kr', 'co.id', 'com.hk', 'com.tr', 'com.ph', 'com.vn',
]);

/**
 * Registrable core of a domain: "abc.co.in" -> "abc", "abc.tech" -> "abc".
 *
 * The old version popped labels only from a hardcoded TLD whitelist, so every
 * newer suffix fell through and the TLD itself became the "core" — abc.tech
 * scored as "tech", abc.biz as "biz", and both were unmatchable.
 */
function domainCore(domain) {
  const parts = String(domain || '').split('.').filter(Boolean);
  if (parts.length <= 1) return parts[0] || domain;
  if (parts.length >= 3 && MULTI_LABEL_SUFFIXES.has(parts.slice(-2).join('.'))) {
    return parts[parts.length - 3];
  }
  return parts[parts.length - 2];
}

/**
 * Score how well a domain core matches the company's brand tokens.
 *
 * The old version only asked "does the core contain any token?", so
 * "Tata Consultancy Services" happily matched tatamotors.com. Leftover
 * letters in the core are now penalised and exact / acronym matches are
 * rewarded, which is what separates tcs.com from tatamotors.com.
 */
function scoreDomain(core, tokens) {
  const joined = tokens.join('');
  const acronym = tokens.map((t) => t[0]).join('');

  if (core === joined) return { score: 18, kind: 'exact' };
  if (tokens.length >= 2 && core === acronym) return { score: 14, kind: 'acronym' };
  // Companies routinely trade under an abbreviation the initials only get
  // close to: BHEL for Bharat Heavy Electricals, KOEL for Kirloskar Oil
  // Engines. Scoring those as "no match" cost a whole class of large firms.
  if (acronym.length >= 3 && core.startsWith(acronym) && core.length <= acronym.length + 2) {
    return { score: 12, kind: 'acronym-prefix' };
  }
  if (joined.startsWith(core) && core.length >= 4) return { score: 13, kind: 'prefix' };
  if (core.startsWith(joined)) return { score: 12, kind: 'startswith' };

  const matched = tokens.filter((t) => t.length >= 3 && core.includes(t));
  if (matched.length === 0) return { score: -6, kind: 'none' };

  let score = matched.length * 5;
  if (matched.length === tokens.length) score += 5;

  // Letters in the domain that no part of the company name explains.
  let leftover = core;
  for (const t of matched) leftover = leftover.replace(t, '');
  if (leftover.length >= 4) score -= 8;        // "tatamotors" -> "motors"
  else if (leftover.length >= 2) score -= 2;

  return { score, kind: `partial(${matched.length}/${tokens.length})` };
}

/**
 * Pick the best candidate for the official website from search results.
 */
async function findOfficialWebsite(companyName, searchResults, log = () => {}) {
  const tokens = brandTokens(companyName);
  if (tokens.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;

  for (const r of searchResults.slice(0, 12)) {
    const url = r.url;
    if (!url || isSocialOrDirectory(url)) continue;

    const domain = getDomain(url);
    const core = domainCore(domain);
    if (!core) continue;

    const { score: domainScore, kind } = scoreDomain(core, tokens);
    let score = domainScore;

    const titleLower = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
    if (titleLower.includes('official')) score += 3;
    const titleHits = tokens.filter((t) => t.length >= 3 && titleLower.includes(t)).length;
    score += Math.min(titleHits, 3) * 2;
    // An acronym domain is only believable if the full name is on the page.
    if (kind.startsWith('acronym') && titleHits === 0) score -= 8;

    // Homepage path is better than deep links; subdomains are usually apps.
    try {
      const path = new URL(url).pathname.replace(/\/$/, '');
      if (path === '') score += 2;
    } catch { /* ignore */ }
    const labels = domain.split('.').length;
    if (labels > 2 && !/^(www|in|us|uk|global|corp)\./.test(domain)) score -= 3;

    log(`  candidate: ${domain} (${kind}, score ${score})`);

    if (score > bestScore) {
      bestScore = score;
      best = { url: `https://${domain}/`, domain, score };
    }
  }

  if (best && bestScore >= 8) return best;
  if (best && tokens.length === 1 && bestScore >= 4) return best;
  return null;
}

/**
 * Try multiple search queries, evaluating each batch of results until the
 * official website passes the scoring threshold.
 */
async function findOfficialWebsiteWithQueries(companyName, queries, searchFn, log = () => {}) {
  for (const q of queries) {
    const results = await searchFn(q);
    log(`  query: "${q}" -> ${results.length} results`);
    const site = await findOfficialWebsite(companyName, results, log);
    if (site) return site;
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 1000));
  }
  return null;
}

module.exports = { findOfficialWebsite, scoreDomain, findOfficialWebsiteWithQueries, isSocialOrDirectory, getDomain, domainCore };
