/**
 * LinkedIn profile finder.
 *
 * Searches for "<Name> <Company> linkedin", scores every candidate against
 * the person's name tokens and the employer, and optionally asks the LLM to
 * break a tie. Returns a URL only when the evidence is strong enough.
 */

const { searchWithFallbackQueries } = require('./search');
const { pickLinkedInWithLlm } = require('./llm');
const { companyTokensOf } = require('./person');
const { brandTokens } = require('./normalize');

const BAD_LINKEDIN_PATHS = [
  '/posts/', '/pulse/', '/activity/', '/jobs/', '/learning/', '/company/',
  '/school/', '/groups/', '/events/', '/search/', '/feed/', '/dir/',
  '/showcase/', '/newsletters/', '/advice/', '/today/',
];

/** linkedin.com/in/<slug> (any country subdomain), not a post/company page. */
function isPersonalProfileUrl(url) {
  if (!/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in|pub)\/[^/]+/i.test(url)) return false;
  const lower = String(url).toLowerCase();
  if (BAD_LINKEDIN_PATHS.some((p) => lower.includes(p))) return false;
  // /in/<slug> must actually have a slug and not be a directory listing
  const slug = profileSlug(url);
  return Boolean(slug && slug.length >= 3);
}

function profileSlug(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    // ['in', '<slug>'] or ['pub', '<slug>', ...]
    return decodeURIComponent(parts[1] || '').toLowerCase();
  } catch {
    return '';
  }
}

/** All lowercase alphabetic tokens of a name, initials included. */
function allNameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Meaningful lowercase tokens of a name (drops single-letter initials). */
function nameTokens(name) {
  return allNameTokens(name).filter((t) => t.length >= 2);
}

/**
 * Score a candidate. >= MATCH_THRESHOLD is accepted.
 *
 * Identity has to be proved one of two ways: the surname appears in the
 * profile slug, or the result title states the full name AND the employer.
 * One of those two being required is what stops "some other Nikhil" from
 * being written into the report.
 */
const MATCH_THRESHOLD = 10;

function validateLinkedInCandidate(url, title, personName, companyName, snippet = '') {
  if (!isPersonalProfileUrl(url)) return 0;

  // "K. Krithivasan" has only one non-initial token; fall back to including
  // the initials so such names get scored instead of automatically failing.
  let person = nameTokens(personName);
  const initialsOnlyName = person.length < 2;
  if (initialsOnlyName) person = allNameTokens(personName);
  if (person.length < 2) return 0;

  const first = person[0];
  const last = person[person.length - 1];

  const slug = profileSlug(url);
  const slugTight = slug.replace(/[^a-z]/g, '');       // "nikhilkamathcio"
  const slugParts = slug.split(/[-_.\d]+/).filter(Boolean);

  const titleLower = String(title || '').toLowerCase();
  const employerText = `${titleLower} ${String(snippet || '').toLowerCase()}`;
  const companyToks = companyTokensOf(companyName);
  const companyMatch = companyToks.some(
    (t) => employerText.includes(t) || slugTight.includes(t)
  );

  const meaningful = person.filter((t) => t.length >= 2);

  // The name as a contiguous run, the way a profile title actually writes it
  // ("Vinod Nahar - Chairman - ..."). Merely finding both tokens loose in the
  // title would let a listicle that mentions several people corroborate any
  // one of their profiles.
  const titleFlat = titleLower.replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').trim();
  const mFirst = meaningful[0];
  const mLast = meaningful[meaningful.length - 1];
  // ...and near the front, where a profile title puts it. A tolerance rather
  // than startsWith, so an honorific ("Dr Vinod Nahar - ...") still counts
  // while a headline that merely mentions him partway through does not.
  const NAME_LEAD_TOLERANCE = 24;
  const fullNameInTitle =
    meaningful.length >= 2 &&
    [meaningful.join(' '), `${mFirst} ${mLast}`, `${mLast} ${mFirst}`].some((run) => {
      const at = titleFlat.indexOf(run);
      return at !== -1 && at <= NAME_LEAD_TOLERANCE;
    });

  const lastInSlug = slugParts.includes(last) || slugTight.includes(last);

  // The surname in the slug is the usual proof of identity. But plenty of
  // real profiles have an abbreviated or custom slug (/in/vinod-n-8a4b21),
  // and rejecting those outright threw away matches a human reads straight
  // off the result: "Vinod Nahar - Chairman - Plasmagen Biosciences".
  // The profile title must identify the person. Employer evidence may also
  // come from the snippet, where search engines put the Experience section.
  if (!lastInSlug) {
    if (fullNameInTitle && companyMatch) return MATCH_THRESHOLD + 2;
    return 0;
  }

  let score = 6;
  // A one-letter first token matches almost any slug, so it earns much less.
  if (first.length === 1) {
    if (slugParts.includes(first)) score += 2;
  } else if (slugParts.includes(first) || slugTight.includes(first)) {
    score += 6;
  } else if (slugTight.startsWith(first.slice(0, 3))) {
    score += 2;
  }

  // Middle names / extra tokens that also line up.
  const extra = person.slice(1, -1).filter((t) => t.length >= 2 && slugTight.includes(t)).length;
  score += extra * 2;

  if (titleLower) {
    // Only real words count — "k" is a substring of half the alphabet soup.
    const inTitle = meaningful.filter((t) => titleLower.includes(t)).length;
    if (meaningful.length && inTitle === meaningful.length) score += 5;
    else score += inTitle * 2;

    if (companyMatch) score += 4;
  }

  // Long digit runs usually mean a different person with the same name.
  if (/\d{4,}/.test(slug)) score -= 3;

  // With only a surname to go on, the employer must corroborate the match.
  if (initialsOnlyName && !companyMatch) score = Math.min(score, MATCH_THRESHOLD - 1);

  return score;
}

/**
 * Find and validate a LinkedIn profile URL for one person.
 * Returns URL string or null.
 */
async function findLinkedInProfile(personName, companyName, designation, log = () => {}) {
  // The full variant list runs regardless of search backend. It looks
  // expensive but isn't: the loop stops at the first query that yields an
  // accepted profile, so the extra variants are only ever spent on a lookup
  // that is already failing — which is exactly when more attempts are worth
  // paying for.

  // "Plasmagen Biosciences Pvt Ltd" is how the company is registered, not how
  // a profile writes it. Quoting the legal name matches nothing; quoting the
  // brand — "Plasmagen Biosciences" — is what a person actually types.
  const brand = brandTokens(companyName).join(' ') || companyName;

  const queries = [
    // site: first — a general query full of celebrity noise used to
    // short-circuit the fallback chain and produce a NULL for everyone.
    `site:linkedin.com/in "${personName}" "${brand}"`,
    `site:linkedin.com/in "${personName}" ${brand}`,
    `"${personName}" ${brand} linkedin`,
    `"${personName}" "${brand}" linkedin profile`,
  ];
  if (designation) {
    queries.push(`site:linkedin.com/in "${personName}" ${designation}`);
    queries.push(`"${personName}" "${designation}" ${brand} linkedin profile`);
  }
  queries.push(`"${personName}" linkedin.com/in ${brand}`);
  // Last resort: the person's headline may not mention the employer at all.
  // Only reached when everything above came back empty, so it costs nothing
  // in the common case; scoring still has to clear the threshold.
  queries.push(`site:linkedin.com/in "${personName}"`);

  // Stop as soon as a profile is found that already clears the bar. Waiting
  // for two *any* profiles burned extra queries on every person, and the
  // resulting search volume is what gets the engines to throttle us on a
  // long company list — which then turns later lookups into NULLs.
  const results = await searchWithFallbackQueries(() => queries, {
    log,
    accept: (r) =>
      isPersonalProfileUrl(r.url) &&
      validateLinkedInCandidate(r.url, r.title, personName, companyName, r.snippet) >= MATCH_THRESHOLD,
    minAccepted: 1,
  });

  const profiles = results.filter((r) => isPersonalProfileUrl(r.url));
  log(`    ${results.length} result(s), ${profiles.length} personal profile(s)`);
  if (profiles.length === 0) {
    log('    no LinkedIn profile in results');
    return null;
  }

  const scored = profiles
    .map((r) => ({ ...r, score: validateLinkedInCandidate(r.url, r.title, personName, companyName, r.snippet) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best && best.score >= MATCH_THRESHOLD) {
    log(`    matched (score ${best.score}): ${best.url}`);
    return best.url;
  }

  // Ambiguous: let the LLM adjudicate if it is configured.
  log(`    weak rule match (best score ${best ? best.score : 0}), trying LLM validation`);
  const llmPick = await pickLinkedInWithLlm(personName, companyName, designation, profiles);
  if (llmPick && isPersonalProfileUrl(llmPick)) {
    // The LLM decides *between* plausible candidates; it does not get to
    // overrule the surname rule. Without this a non-person that slipped
    // through ("AIG Hospitals") was handed someone else's profile.
    const chosen = profiles.find((p) => p.url === llmPick) || { url: llmPick, title: '' };
    const sanity = validateLinkedInCandidate(chosen.url, chosen.title, personName, companyName, chosen.snippet);
    if (sanity > 0) {
      log(`    LLM picked: ${llmPick}`);
      return llmPick;
    }
    log(`    LLM pick rejected (surname not in profile): ${llmPick}`);
  }

  log('    no confident LinkedIn match found');
  return null;
}

module.exports = {
  findLinkedInProfile,
  isPersonalProfileUrl,
  validateLinkedInCandidate,
  profileSlug,
};
