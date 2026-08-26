/**
 * Company name normalization + regex matching.
 * "ABC PRIVATE LIMITED", "ABC Pvt Ltd", "abc private ltd" -> "abc"
 */

const LEGAL_SUFFIXES = [
  'private limited', 'pvt ltd', 'pvt. ltd.', 'pvt ltd.', 'pvt. ltd',
  'private', 'pvt', 'public',
  'limited liability partnership', 'llp', 'l.l.p',
  'public limited company', 'plc',
  'incorporated', 'inc', 'inc.',
  'corporation', 'corp', 'corp.',
  'company', 'co', 'co.',
  'limited', 'ltd', 'ltd.',
  'llc', 'l.l.c',
  'gmbh', 'ag', 'sa', 'bv', 'pty ltd', 'pte ltd',
  'group of companies', 'group',
  'industries', 'enterprises', 'holdings', 'technologies', 'technology',
  'solutions', 'services', 'ventures'
];

// Sort longest first so "private limited" is stripped before "limited"
const SORTED_SUFFIXES = [...LEGAL_SUFFIXES].sort((a, b) => b.length - a.length);

function stripAccents(str) {
  return str.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function basicClean(name) {
  if (!name || typeof name !== 'string') return '';
  return stripAccents(name)
    .toLowerCase()
    .replace(/[^\w\s&]/g, ' ')   // drop punctuation/special chars
    .replace(/\s+/g, ' ')        // collapse whitespace
    .trim();
}

/**
 * Fully normalized key for dedupe/matching:
 * lowercase, no punctuation, no legal suffixes, no stopwords.
 */
function normalizeCompanyName(rawName) {
  let name = basicClean(rawName);
  if (!name) return '';

  // Repeatedly strip legal suffixes from the end
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of SORTED_SUFFIXES) {
      const re = new RegExp(`\\s+${suffix.replace(/\./g, '\\.')}$`);
      if (re.test(name)) {
        name = name.replace(re, '').trim();
        changed = true;
        break;
      }
    }
  }

  const stop = new Set(['the', 'and', 'of', 'a', 'an', 'for']);
  const tokens = name.split(' ').filter((t) => t && !stop.has(t));
  return tokens.join(' ');
}

// Only entity/legal forms — NOT descriptive words like "services" or
// "industries", which are part of the real brand ("Tata Consultancy Services"
// -> tcs.com) and are needed for domain and acronym matching.
const ENTITY_SUFFIXES = [
  'private limited', 'pvt ltd', 'pvt. ltd.', 'pvt ltd.', 'pvt. ltd',
  'public limited company', 'limited liability partnership',
  'private', 'pvt', 'public', 'llp', 'l.l.p', 'plc', 'incorporated', 'inc',
  'inc.', 'corporation', 'corp', 'corp.', 'company', 'co', 'co.', 'limited',
  'ltd', 'ltd.', 'llc', 'l.l.c', 'gmbh', 'ag', 'sa', 'bv', 'pty ltd',
  'pte ltd', 'and sons', 'group of companies',
].sort((a, b) => b.length - a.length);

/**
 * Brand tokens: legal entity forms removed, everything descriptive kept.
 * "Tata Consultancy Services Ltd" -> ['tata','consultancy','services']
 */
function brandTokens(rawName) {
  let name = basicClean(rawName);
  if (!name) return [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of ENTITY_SUFFIXES) {
      const re = new RegExp(`\\s+${suffix.replace(/\./g, '\\.')}$`);
      if (re.test(name)) {
        name = name.replace(re, '').trim();
        changed = true;
        break;
      }
    }
  }

  const stop = new Set(['the', 'and', 'of', 'a', 'an', 'for', '&']);
  return name.split(' ').filter((t) => t && !stop.has(t));
}

/** Human-friendly display version (single spaced). */
function displayName(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';
  return rawName.replace(/\s+/g, ' ').trim();
}

/** Case-insensitive fuzzy equality between two company names. */
function sameCompany(a, b) {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // token containment: "abc technologies" vs "abc"
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let hits = 0;
  for (const t of small) if (large.has(t)) hits++;
  return hits / small.size >= 0.8 && hits >= 1;
}

module.exports = { normalizeCompanyName, brandTokens, displayName, sameCompany, basicClean };
