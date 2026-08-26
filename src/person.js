/**
 * Person-name and designation utilities.
 *
 * Everything that decides "is this string a real human name?" lives here so
 * the crawler, the LinkedIn matcher and the LLM post-filter all agree.
 *
 * Key rules that keep junk like "Board", "ries", "staying a", "Search",
 * "Help" out of the results:
 *   - designations are matched on WORD BOUNDARIES (so "cto" no longer matches
 *     "dire-cto-r" and "head of" no longer matches "a-head of")
 *   - a name needs >= 2 capitalised tokens, none of which may be a common
 *     English / UI / corporate word
 */

// Longest first so "managing director" wins over "director".
const DESIGNATION_KEYWORDS = [
  'chief executive officer', 'chief financial officer', 'chief operating officer',
  'chief technology officer', 'chief information officer', 'chief marketing officer',
  'chief business officer', 'chief investment officer', 'chief people officer',
  'chief human resources officer', 'chief revenue officer', 'chief product officer',
  'chief strategy officer', 'chief compliance officer', 'chief risk officer',
  'chief commercial officer', 'chief digital officer', 'chief security officer',
  'company secretary', 'chief general manager', 'deputy general manager',
  'non executive director', 'non-executive director', 'whole time director',
  'whole-time director', 'wholetime director', 'independent director',
  'additional director', 'nominee director', 'alternate director',
  'joint managing director', 'deputy managing director',
  'executive director', 'managing director', 'executive chairman',
  'executive vice president', 'senior vice president', 'vice chairman',
  'vice president', 'managing partner', 'senior partner', 'general manager',
  'general partner', 'board member', 'group director', 'country head',
  'business head', 'head of',
  'director', 'chairman', 'chairperson', 'chairwoman',
  'co-founder', 'cofounder', 'co founder', 'founder',
  'president', 'proprietor', 'promoter', 'principal', 'partner',
  'ceo', 'cfo', 'coo', 'cto', 'cio', 'cmo', 'chro', 'cxo',
];

const CANONICAL = {
  ceo: 'CEO', cfo: 'CFO', coo: 'COO', cto: 'CTO', cio: 'CIO', cmo: 'CMO',
  chro: 'CHRO', cxo: 'CXO', md: 'Managing Director',
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

/**
 * Case-insensitive *by construction* ("director" -> "[Dd][Ii]..."), so a
 * pattern can mix these with case-sensitive name parts ([A-Z]...) in one
 * regex without needing the `i` flag, which would defeat the name rules.
 */
function escapeReCI(s) {
  return s
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[a-zA-Z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`)
    .replace(/ +/g, '\\s+');
}

// \b...\b + optional plural. Boundaries are what kill the substring matches.
const DESIGNATION_ALT = DESIGNATION_KEYWORDS.map(escapeRe).join('|');
const DESIGNATION_ALT_CI = DESIGNATION_KEYWORDS.map(escapeReCI).join('|');

// Qualifiers that can precede a title: "Non-Executive Independent Director".
const DESIGNATION_QUALIFIERS = [
  'non', 'independent', 'executive', 'managing', 'deputy', 'joint', 'senior',
  'vice', 'chief', 'whole', 'wholetime', 'whole-time', 'additional', 'nominee',
  'alternate', 'group', 'country', 'global', 'regional', 'national', 'acting',
  'interim', 'associate', 'assistant', 'corporate', 'honorary', 'founding',
];
const QUALIFIER_ALT_CI = DESIGNATION_QUALIFIERS.map(escapeReCI).join('|');
const DESIGNATION_SOURCE = `\\b(${DESIGNATION_ALT})s?\\b`;
const DESIGNATION_RE = new RegExp(DESIGNATION_SOURCE, 'i');

/** Does this text contain a real designation (word-boundary match)? */
function looksLikeDesignation(text) {
  if (!text) return false;
  return new RegExp(DESIGNATION_SOURCE, 'i').test(text);
}

/** All designation matches in a text: [{ keyword, match, index, length }] */
function findDesignations(text) {
  const out = [];
  if (!text) return out;
  const re = new RegExp(DESIGNATION_SOURCE, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      keyword: m[1].toLowerCase(),
      match: m[0],
      index: m.index,
      length: m[0].length,
    });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'shri', 'sri', 'smt',
  'shrimati', 'sh', 'er', 'ca', 'cs', 'cma', 'adv', 'advocate', 'sir',
  'late', 'hon', 'honble', 'justice', 'capt', 'col', 'maj', 'gen', 'lt', 'rev',
]);

// Lowercase particles that may appear inside a real name.
const NAME_PARTICLES = new Set([
  'de', 'del', 'della', 'da', 'das', 'dos', 'di', 'du', 'van', 'von', 'der',
  'den', 'ten', 'ter', 'la', 'le', 'bin', 'binti', 'al', 'el', 'ibn', 'mac',
  'mc', 'san', 'santa', 'st', 'y',
]);

/**
 * Words that are never part of a person's name in this context.
 * Deliberately excludes anything that doubles as a common given name
 * (Grace, Hope, Mark, May, June, Rose, Bill, Frank, Art, Will, ...).
 */
const NON_NAME_WORDS = new Set([
  // navigation / UI
  'home', 'about', 'aboutus', 'contact', 'contacts', 'search', 'help', 'support',
  'login', 'logout', 'register', 'signin', 'signup', 'subscribe', 'submit',
  'menu', 'close', 'open', 'back', 'next', 'previous', 'prev', 'more', 'less',
  'view', 'click', 'here', 'read', 'learn', 'download', 'share', 'follow',
  'toggle', 'skip', 'select', 'filter', 'sort', 'apply', 'cancel', 'continue',
  'sitemap', 'faq', 'faqs', 'blog', 'news', 'events', 'event', 'gallery', 'media',
  'careers', 'career', 'jobs', 'job', 'account', 'profile', 'dashboard',
  'language', 'english', 'hindi', 'newsletter', 'cookie', 'cookies', 'privacy',
  'policy', 'terms', 'conditions', 'disclaimer', 'copyright', 'reserved',
  'rights', 'legal', 'links', 'link', 'quick', 'useful', 'important',
  // corporate / page nouns
  'company', 'companies', 'corporate', 'corporation', 'business', 'group',
  'team', 'teams', 'board', 'boards', 'committee', 'council', 'management',
  'leadership', 'governance', 'organisation', 'organization', 'department',
  'division', 'branch', 'office', 'offices', 'headquarters', 'staff',
  'employee', 'employees', 'people', 'person', 'member', 'members',
  'client', 'clients', 'customer', 'customers', 'partners',
  'investor', 'investors', 'shareholder', 'shareholders', 'stakeholder',
  'service', 'services', 'solution', 'solutions', 'product', 'products',
  'industry', 'industries', 'sector', 'sectors', 'market', 'markets',
  'technology', 'technologies', 'enterprise', 'enterprises', 'ventures',
  'holdings', 'limited', 'ltd', 'pvt', 'private', 'inc', 'llc', 'llp', 'plc',
  'report', 'reports', 'annual', 'quarterly', 'results', 'financial',
  'finance', 'investment', 'investments', 'fund', 'funds', 'capital',
  'project', 'projects', 'portfolio', 'overview', 'mission', 'vision',
  'values', 'history', 'story', 'journey', 'award', 'awards', 'achievement',
  'achievements', 'certificate', 'certification', 'quality', 'safety',
  'sustainability', 'csr', 'esg', 'compliance', 'policies', 'notice',
  'notices', 'announcement', 'announcements', 'press', 'release', 'releases',
  'testimonial', 'testimonials', 'resources', 'resource', 'insights',
  'article', 'articles', 'case', 'studies', 'study', 'whitepaper', 'ebook',
  'webinar', 'conference', 'seminar', 'workshop', 'training', 'course',
  'address', 'phone', 'email', 'mail', 'fax', 'website', 'web', 'page',
  'welcome', 'greetings', 'message', 'messages', 'statement', 'introduction',
  'summary', 'details', 'information', 'info', 'data', 'update', 'updates',
  'directory', 'directories', 'listing', 'listings', 'category', 'categories',
  'bio', 'biography', 'ecommerce', 'commerce', 'retail', 'brand', 'brands',
  // organisation nouns — partner/client lists otherwise become "people"
  // ("AIG Hospitals", "Fortis Hospitals" were showing up as directors)
  'hospital', 'hospitals', 'clinic', 'clinics', 'healthcare', 'health',
  'labs', 'laboratory', 'laboratories', 'diagnostics', 'pharma',
  'pharmaceuticals', 'bank', 'banking', 'insurance', 'institute', 'institution',
  'university', 'college', 'school', 'academy', 'foundation', 'trust',
  'society', 'association', 'federation', 'chamber', 'bureau', 'agency',
  'agencies', 'systems', 'system', 'networks', 'network', 'motors', 'steel',
  'cement', 'textiles', 'mills', 'traders', 'trading', 'exports', 'imports',
  'infrastructure', 'constructions', 'developers', 'builders', 'properties',
  'realty', 'estates', 'logistics', 'transport', 'travels', 'hotels',
  'resorts', 'restaurants', 'foods', 'beverages', 'motor', 'automobiles',
  // sites and publications that get glued to names in search-result titles
  'wikipedia', 'linkedin', 'facebook', 'twitter', 'instagram', 'youtube',
  'forbes', 'bloomberg', 'reuters', 'crunchbase', 'glassdoor', 'moneycontrol',
  'economic', 'times', 'business', 'standard', 'mint', 'craft', 'zoominfo',
  'britannica', 'fortune', 'inc', 'entrepreneur', 'hindu', 'express',
  // filler / function words
  'the', 'and', 'or', 'but', 'for', 'nor', 'yet', 'so', 'of', 'in', 'on',
  'at', 'to', 'from', 'by', 'with', 'without', 'within', 'into',
  'onto', 'over', 'under', 'above', 'below', 'between', 'through', 'during',
  'before', 'after', 'since', 'until', 'while', 'this', 'that', 'these',
  'those', 'our', 'your', 'their', 'its', 'his', 'her', 'we', 'you',
  'they', 'she', 'it', 'us', 'them', 'him', 'all', 'any', 'each',
  'every', 'some', 'not', 'only', 'also', 'very', 'most',
  'other', 'others', 'such', 'own', 'same', 'than', 'then', 'once',
  'there', 'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
  'do', 'does', 'did', 'can', 'could', 'should', 'would',
  'must', 'shall', 'staying', 'stay', 'ahead', 'leading', 'lead', 'led',
  'growing', 'growth', 'building', 'built', 'making',
  'working', 'delivering', 'deliver', 'providing', 'provide',
  'helping', 'creating', 'create', 'driving', 'firm', 'firms',
  'years', 'year', 'experience', 'expertise', 'excellence', 'commitment',
  'meet', 'meeting', 'join', 'joining', 'visit', 'explore', 'discover',
  'know', 'knowing', 'seen', 'find', 'found',
  'new', 'latest', 'best', 'top', 'first', 'second', 'third', 'last',
]);

/**
 * Leading words of a job title. When one of these ends up glued to a name
 * ("Vedika Bhandarkar Non-Executive", "Natarajan Chandrasekaran Non") it is a
 * fragment of the adjacent designation, not part of the person.
 */
const DESIGNATION_FRAGMENTS = new Set([
  'non', 'nonexecutive', 'executive', 'independent', 'managing', 'deputy',
  'joint', 'senior', 'vice', 'chief', 'whole', 'wholetime', 'additional',
  'nominee', 'alternate', 'group', 'country', 'business', 'board', 'general',
  'acting', 'interim', 'associate', 'assistant', 'co', 'global', 'regional',
  'national', 'corporate', 'honorary', 'emeritus', 'former', 'ex',
]);

/** Strip honorifics, credentials, DIN numbers, trailing punctuation. */
function cleanName(raw) {
  let n = String(raw || '')
    .replace(/[ ​]/g, ' ')
    .replace(/\(.*?\)/g, ' ')            // "(DIN: 01234567)"
    .replace(/\[.*?\]/g, ' ')
    .replace(/\bDIN\s*[:\-]?\s*\d+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^A-Za-z]+/, '')
    .replace(/[^A-Za-z.'’\-]+$/, '')
    .trim();

  let toks = n.split(/\s+/).filter(Boolean);

  // leading honorifics ("Mr.", "Shri", "CA")
  while (toks.length > 1) {
    const t = toks[0].toLowerCase().replace(/[^a-z]/g, '');
    if (HONORIFICS.has(t)) toks.shift();
    else break;
  }
  // trailing connectors and designation fragments that bled in from the title
  const trailingStop = new Set(['and', '&', 'of', 'the', 'is', 'was', 'a', 'an', 'cum']);
  while (toks.length > 1) {
    const t = toks[toks.length - 1].toLowerCase().replace(/[^a-z]/g, '');
    if (!t || trailingStop.has(t) || DESIGNATION_FRAGMENTS.has(t)) toks.pop();
    else break;
  }
  // Snippets often repeat a name back to back ("K. Krithivasan K. Krithivasan").
  if (toks.length >= 2 && toks.length % 2 === 0) {
    const half = toks.length / 2;
    const a = toks.slice(0, half).join(' ').toLowerCase();
    const b = toks.slice(half).join(' ').toLowerCase();
    if (a === b) toks = toks.slice(0, half);
  }

  return toks.join(' ').replace(/[\-–—,;:.]+$/, '').trim();
}

const TOKEN_RE = /^(?:[A-Z][A-Za-z'’\-]*\.?|(?:[A-Z]\.){1,3}|[A-Z]\.?|[A-Z]{2,})$/;

// A run of dotted initials written as one token: "K.", "M.K.", "N.R.".
// Indian board listings use this constantly and it must not be mistaken for
// a real word, or "M.K. Sharma" would look like it has two substantive parts.
const INITIAL_CLUSTER_RE = /^(?:[A-Z]\.){1,3}$/;

/**
 * Strict person-name test.
 * Requires 2-5 tokens, each capitalised, none a known non-name word,
 * and at least two "substantive" (non-initial) tokens.
 */
function isValidPersonName(name, { companyTokens = [] } = {}) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (n.length < 5 || n.length > 50) return false;
  if (/[0-9@#$%^*_=+<>{}[\]/\\|~`"]/.test(n)) return false;
  if (looksLikeDesignation(n)) return false;

  const toks = n.split(/\s+/).filter(Boolean);
  if (toks.length < 2 || toks.length > 5) return false;

  let substantive = 0;
  let initials = 0;
  let longestSubstantive = 0;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const bare = tok.toLowerCase().replace(/[^a-z']/g, '');
    if (!bare) return false;

    const isParticle = NAME_PARTICLES.has(bare) && i > 0 && i < toks.length - 1;
    if (isParticle) continue;

    if (!TOKEN_RE.test(tok)) return false;      // must start uppercase
    if (NON_NAME_WORDS.has(bare)) return false; // "Board", "Search", "Our"...
    if (HONORIFICS.has(bare)) return false;
    if (DESIGNATION_FRAGMENTS.has(bare)) return false; // "Non-Executive", "Vice"
    if (INITIAL_CLUSTER_RE.test(tok)) initials++;
    else if (bare.length >= 2) { substantive++; longestSubstantive = Math.max(longestSubstantive, bare.length); }
    else initials++;
  }

  // Normally two real words. An initial plus one real name is legitimate in
  // either order — "K. Krithivasan" and "Krithivasan K." are the same person,
  // and the initial-last convention is standard across South India.
  if (substantive < 2) {
    if (!(substantive === 1 && initials >= 1 && longestSubstantive >= 3)) return false;
  }

  // Don't let the company name itself — or a title with the brand glued to
  // the front ("Nykaa Falguni Nayar", "Nykaa Beauty") — become a person.
  //
  // The brand always leads in that failure mode, so only the first token is
  // disqualifying. Rejecting *any* shared token instead threw away the real
  // answer at every eponymous firm in the country: "Rajiv Bajaj" at Bajaj
  // Auto, "Anand Mahindra" at Mahindra, every Agarwal at Agarwal Industries.
  if (companyTokens.length) {
    const nameToks = toks.map((t) => t.toLowerCase().replace(/[^a-z]/g, ''));
    if (companyTokens.includes(nameToks[0])) return false;
    if (nameToks.every((t) => companyTokens.includes(t))) return false;
  }
  return true;
}

// Words that mean the job title has ended and prose has begun.
const DESIGNATION_STOP_WORDS = new Set([
  'bio', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'he', 'she', 'they',
  'who', 'whose', 'his', 'her', 'their', 'joined', 'joins', 'brings', 'leads',
  'led', 'started', 'founded', 'holds', 'oversees', 'heads', 'manages',
  'with', 'since', 'prior', 'before', 'after', 'currently', 'also', 'read',
  'more', 'view', 'profile', 'linkedin', 'email', 'contact', 'about', 'over',
]);

/**
 * Trim a raw phrase down to the job title itself.
 * Spans from the first designation keyword to the last one that is still
 * close by, then allows a couple of qualifier words ("Director - Strategy")
 * but stops the moment prose starts ("Founder & CFO Bio Nikhil is an ...").
 */
function tidyDesignation(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const hits = findDesignations(text);
  if (!hits.length) return text;

  const start = hits[0].index;
  let end = hits[0].index + hits[0].length;
  for (let i = 1; i < hits.length; i++) {
    const gap = hits[i].index - end;
    if (gap < 0 || gap > 12) break;              // "Founder & CFO" yes, a sentence away no
    if (/[.;|]/.test(text.slice(end, hits[i].index))) break;
    end = hits[i].index + hits[i].length;
  }

  // Allow up to 3 trailing qualifier words ("Director - Strategy & Ops").
  const tail = text.slice(end);
  const tailTokens = tail.split(/(\s+|[,\-–—&/]+)/).filter((t) => t !== '');
  let taken = '';
  let words = 0;
  for (const tok of tailTokens) {
    if (/^\s+$/.test(tok) || /^[,\-–—&/]+$/.test(tok)) { taken += tok; continue; }
    if (/[.;|:]/.test(tok)) break;
    const bare = tok.toLowerCase().replace(/[^a-z]/g, '');
    if (!bare || DESIGNATION_STOP_WORDS.has(bare)) break;
    if (++words > 3) break;
    taken += tok;
  }

  return (text.slice(start, end) + taken).replace(/[\s,\-–—&/]+$/, '').trim();
}

/** Turn a matched keyword / raw phrase into a presentable designation. */
function normalizeDesignation(raw) {
  let d = tidyDesignation(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s\-–—:,|·•]+/, '')
    .replace(/[\s\-–—:,|·•]+$/, '');
  if (!d) return '';
  if (d.length > 60) d = d.slice(0, 60).replace(/\s+\S*$/, '');

  const key = d.toLowerCase().replace(/[^a-z]/g, '');
  if (CANONICAL[key]) return CANONICAL[key];

  return d
    .split(' ')
    .map((w) => {
      const bare = w.toLowerCase().replace(/[^a-z]/g, '');
      if (CANONICAL[bare]) return CANONICAL[bare];
      if (['and', 'of', 'the', 'to'].includes(bare)) return bare;
      // title-case across hyphens too: "co-founder" -> "Co-Founder"
      return w
        .toLowerCase()
        .replace(/(^|[-–—/&])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase())
        .replace(/\b(ceo|cfo|coo|cto|cio|cmo|chro|cxo)\b/gi, (s) => s.toUpperCase());
    })
    .join(' ');
}

/**
 * How much of a designation string is actually job title (vs. filler)?
 * Used to pick the better of two designations for the same person, instead
 * of blindly taking the longer one (which let bio sentences win).
 */
function designationQuality(d) {
  const text = String(d || '').trim();
  if (!text) return -1;
  const covered = findDesignations(text).reduce((n, h) => n + h.length, 0);
  if (!covered) return 0;
  // more title characters is better; excess filler is a penalty
  return covered * 2 - (text.length - covered);
}

/** Pick the more informative of two designations for the same person. */
function betterDesignation(a, b) {
  const qa = designationQuality(a);
  const qb = designationQuality(b);
  if (qa !== qb) return qa > qb ? a : b;
  return (a || '').length >= (b || '').length ? a : b;
}

// Director-level and above. Used where a title is the only evidence we have
// (LinkedIn search results), to avoid reporting mid-level staff as leadership.
const SENIOR_TITLE_RE =
  /\b(chief\s+\w+(\s+\w+)?\s+officer|c[efomit]o|chro|cxo|managing\s+director|executive\s+director|independent\s+director|whole[\s-]?time\s+director|non[\s-]?executive\s+director|nominee\s+director|additional\s+director|group\s+director|board\s+member|director|chairman|chairperson|chairwoman|co[\s-]?founder|founder|president|proprietor|promoter|managing\s+partner|senior\s+partner|company\s+secretary|country\s+head|business\s+head|general\s+manager)\b/i;

function isSeniorDesignation(d) {
  return SENIOR_TITLE_RE.test(String(d || ''));
}

/** Stable key for de-duplicating the same human written slightly differently. */
function nameKey(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .split(' ')
    .filter((t) => t.length > 1);
  // de-duplicate so "K. Krithivasan" and a doubled "K. Krithivasan
  // K. Krithivasan" collapse onto the same person
  return [...new Set(tokens)].sort().join('-');
}

function companyTokensOf(companyName) {
  return String(companyName || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !NON_NAME_WORDS.has(t));
}

module.exports = {
  DESIGNATION_KEYWORDS,
  DESIGNATION_RE,
  DESIGNATION_SOURCE,
  DESIGNATION_ALT,
  DESIGNATION_ALT_CI,
  QUALIFIER_ALT_CI,
  NAME_PARTICLES,
  HONORIFICS,
  looksLikeDesignation,
  findDesignations,
  isValidPersonName,
  cleanName,
  normalizeDesignation,
  tidyDesignation,
  designationQuality,
  betterDesignation,
  isSeniorDesignation,
  nameKey,
  companyTokensOf,
  NON_NAME_WORDS,
};
