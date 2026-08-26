/**
 * Leadership extraction from HTML.
 *
 * Replaces the old "split the text around a keyword and keep whatever is on
 * either side" approach, which produced fragments like "ries", "staying a"
 * and picked up nav labels ("Search", "Help", "Board") as people.
 *
 * Three passes, each producing scored candidates:
 *   A. designation node  -> nearest name in the same card (highest confidence)
 *   B. adjacency regex   -> "Name, Managing Director" / "Managing Director: Name"
 *   C. heading + sibling -> <h3>Name</h3><p>Director</p>
 *
 * Only candidates that pass the strict person-name test in person.js survive.
 */

const cheerio = require('cheerio');
const {
  DESIGNATION_ALT_CI,
  QUALIFIER_ALT_CI,
  findDesignations,
  NON_NAME_WORDS,
  HONORIFICS,
  looksLikeDesignation,
  isValidPersonName,
  cleanName,
  normalizeDesignation,
  betterDesignation,
  nameKey,
  companyTokensOf,
} = require('./person');

/** Chrome/cheerio's .text() concatenates block content; inject separators. */
function withSeparators(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' | ')
    .replace(/<\/(p|div|h[1-6]|li|tr|td|th|section|article|span|strong|b|em|a|figcaption|dt|dd)\s*>/gi, ' </$1> ');
}

/** Strip chrome that never contains real leadership data. */
function prepareDom(html) {
  const $ = cheerio.load(withSeparators(html));
  $('script, style, noscript, svg, iframe, form, select, option, textarea, button').remove();
  $('nav, header, footer, aside').remove();
  const noisy = [
    '[class*="nav" i]', '[id*="nav" i]', '[class*="menu" i]', '[id*="menu" i]',
    '[class*="breadcrumb" i]', '[class*="cookie" i]', '[class*="sidebar" i]',
    '[class*="newsletter" i]', '[class*="search" i]', '[id*="search" i]',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="search"]',
  ];
  for (const sel of noisy) {
    try { $(sel).remove(); } catch { /* selector unsupported */ }
  }
  return $;
}

function textOf($el) {
  return ($el.text() || '').replace(/\s+/g, ' ').replace(/\s*\|\s*/g, ' | ').trim();
}

/** Text of an element excluding nested block children (its "own" label). */
function ownText($, el) {
  return $(el)
    .contents()
    .filter((_, n) => n.type === 'text')
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this element's whole text essentially JUST a job title?
 * Yes: "Managing Director", "Co-Founder & CEO", "Director - Operations"
 * No:  "Rajesh Kumar Sharma Managing Director" (a card wrapper — the name is
 *      still in there, so pairing it with itself would swallow the name into
 *      the designation), "Mr. Anil B. Gupta, Independent Director" (pass B).
 */
function isDesignationLabel(txt) {
  if (!txt || txt.length > 70) return false;
  if (!looksLikeDesignation(txt)) return false;

  const hits = findDesignations(txt);
  const covered = hits.reduce((n, h) => n + h.length, 0);
  if (covered / txt.replace(/\s+/g, ' ').length < 0.25) return false;

  // Remove the titles and see whether a person's name is left over.
  let rest = txt;
  for (const h of [...hits].sort((a, b) => b.index - a.index)) {
    rest = rest.slice(0, h.index) + ' ' + rest.slice(h.index + h.length);
  }
  const leftoverNameTokens = rest
    .split(/[\s,&|/·•\-–—:()]+/)
    .filter((t) => /^[A-Z][A-Za-z'’.\-]{1,}$/.test(t))
    .filter((t) => {
      const bare = t.toLowerCase().replace(/[^a-z]/g, '');
      return bare.length >= 2 && !NON_NAME_WORDS.has(bare) && !HONORIFICS.has(bare);
    });
  return leftoverNameTokens.length < 2;
}

const NAME_SELECTORS = 'h1,h2,h3,h4,h5,h6,strong,b,a,span,p,div,td,figcaption,dt';

/**
 * Walk outward from a designation label looking for the person's name in the
 * same card. Nearest-first: siblings, then progressively larger ancestors
 * (bailing out once the ancestor is clearly a grid, not a card).
 */
function findNameNear($, el, companyTokens) {
  const tryText = (raw) => {
    if (!raw) return null;
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 60) return null;
    if (looksLikeDesignation(t)) return null;
    const name = cleanName(t.split('|')[0]);
    return isValidPersonName(name, { companyTokens }) ? name : null;
  };

  const $el = $(el);

  // 1. immediate siblings (name usually sits right above the title)
  const sibs = [];
  $el.prevAll().slice(0, 4).each((_, n) => sibs.push(n));
  $el.nextAll().slice(0, 2).each((_, n) => sibs.push(n));
  for (const n of sibs) {
    const hit = tryText(textOf($(n)));
    if (hit) return hit;
  }

  // 2. climb ancestors while they still look like a single card
  let $p = $el.parent();
  for (let depth = 0; depth < 5 && $p.length; depth++) {
    const cardText = textOf($p);
    if (cardText.length > 400) break; // now a listing/grid, name would be ambiguous

    const inner = $p.find(NAME_SELECTORS).toArray().slice(0, 40);
    for (const n of inner) {
      if (n === el) continue;
      const hit = tryText(ownText($, n)) || tryText(textOf($(n)));
      if (hit) return hit;
    }

    // image alt / title attributes are a common fallback on team cards
    const img = $p.find('img[alt], img[title]').first();
    if (img.length) {
      const hit = tryText(img.attr('alt')) || tryText(img.attr('title'));
      if (hit) return hit;
    }

    const prevSib = $p.prev();
    if (prevSib.length) {
      const hit = tryText(textOf(prevSib));
      if (hit) return hit;
    }
    $p = $p.parent();
  }
  return null;
}

/** Pass A: elements whose entire text is a job title. */
function passDesignationNodes($, companyTokens, push) {
  $('p, span, div, h3, h4, h5, h6, li, td, small, em, strong, b, figcaption, dd').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 3) return;           // container, not a label
    const txt = textOf($el);
    if (!isDesignationLabel(txt)) return;
    const name = findNameNear($, el, companyTokens);
    if (!name) return;
    push(name, normalizeDesignation(txt), 5);
  });
}

// "Rajesh Kumar Sharma, Managing Director" / "Rajesh Kumar Sharma - CEO"
// Case-insensitive titles, case-SENSITIVE names -> no `i` flag on these.
// Leading qualifiers are allowed so "Non-Executive Independent Director"
// is recognised as one title rather than name-fragment + title.
const TITLE_CI = `(?:(?:${QUALIFIER_ALT_CI})[\\s-]+){0,3}(?:${DESIGNATION_ALT_CI})[Ss]?`;
const NAME_CORE = "[A-Z][A-Za-z'’.\\-]*(?:\\s+[A-Z][A-Za-z'’.\\-]*){1,4}";
// A bare "-" must have whitespace around it, otherwise "Non-Executive
// Director" gets split into the name "... Non" + title "Executive Director".
const SEP =
  "(?:\\s*[,:|·•(]\\s*|\\s*[-–—]\\s+|\\s+[-–—]\\s*|\\s+(?:is|as|serves\\s+as|was\\s+appointed)\\s+(?:the\\s+|our\\s+|a\\s+|an\\s+)?)";

const NAME_THEN_TITLE = new RegExp(`(${NAME_CORE})${SEP}(${TITLE_CI}[^,.;|\\n]{0,35})`, 'g');
// "Managing Director: Rajesh Kumar Sharma", "CEO – Rajesh Kumar Sharma",
// "the Chairman is Rajesh Kumar Sharma", "Managing Director Rajesh Kumar Sharma"
// (prose forms are common in search snippets, which is all we have when the
// company's own site is behind a bot wall).
const TITLE_THEN_NAME = new RegExp(
  `\\b(${TITLE_CI})(?:\\s*[,\\-–—:|·•]\\s*|\\s+(?:is|was|:)\\s+|\\s+)(${NAME_CORE})`,
  'g'
);

/** Pass B: strict adjacency inside short blocks of text. */
function passAdjacency($, companyTokens, push) {
  $('p, li, td, div, span, h1, h2, h3, h4, h5, h6, dd, dt, figcaption').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 6) return;
    const txt = textOf($el);
    if (txt.length < 8 || txt.length > 300) return;
    if (!looksLikeDesignation(txt)) return;

    let m;
    NAME_THEN_TITLE.lastIndex = 0;
    while ((m = NAME_THEN_TITLE.exec(txt)) !== null) {
      const name = cleanName(m[1]);
      if (isValidPersonName(name, { companyTokens })) {
        push(name, normalizeDesignation(m[2]), 4);
      }
    }
    TITLE_THEN_NAME.lastIndex = 0;
    while ((m = TITLE_THEN_NAME.exec(txt)) !== null) {
      const name = cleanName(m[2]);
      if (isValidPersonName(name, { companyTokens })) {
        push(name, normalizeDesignation(m[1]), 3);
      }
    }
  });
}

/** Pass C: <h3>Name</h3> followed by a title element. */
function passHeadings($, companyTokens, push) {
  $('h1, h2, h3, h4, h5, h6, strong, b, a').each((_, el) => {
    const $el = $(el);
    const raw = ownText($, el) || textOf($el);
    if (!raw || raw.length > 60) return;
    const name = cleanName(raw.split('|')[0]);
    if (!isValidPersonName(name, { companyTokens })) return;

    // look at the next couple of siblings for the title
    let $sib = $el.next();
    for (let i = 0; i < 3 && $sib.length; i++) {
      const t = textOf($sib);
      if (isDesignationLabel(t)) {
        push(name, normalizeDesignation(t), 4);
        return;
      }
      $sib = $sib.next();
    }
    // otherwise a short parent block that contains exactly one title
    const parentText = textOf($el.parent());
    if (parentText.length <= 200) {
      const hits = findDesignations(parentText);
      if (hits.length) push(name, normalizeDesignation(hits[0].match), 2);
    }
  });
}

/**
 * Extract leadership candidates from a page.
 * Returns [{ name, designation, score }] sorted by confidence.
 */
function extractLeaders(html, companyName = '') {
  const $ = prepareDom(html);
  const companyTokens = companyTokensOf(companyName);
  const found = new Map();

  const push = (name, designation, score) => {
    if (!name || !isValidPersonName(name, { companyTokens })) return;
    const key = nameKey(name);
    if (!key) return;
    const prev = found.get(key);
    if (!prev) {
      found.set(key, { name, designation: designation || '', score });
      return;
    }
    prev.score += score;                                  // corroboration
    prev.designation = betterDesignation(prev.designation, designation || '');
    if (name.length > prev.name.length) prev.name = name; // prefer fuller form
  };

  passDesignationNodes($, companyTokens, push);
  passAdjacency($, companyTokens, push);
  passHeadings($, companyTokens, push);

  // People whose title couldn't be paired used to be dropped here, silently.
  // They are kept now but ranked strictly below anyone with a stated title,
  // so a caller can take them only when nothing better turned up.
  return mergeSubsetNames([...found.values()])
    .sort((a, b) =>
      Number(Boolean(b.designation)) - Number(Boolean(a.designation)) ||
      b.score - a.score);
}

/**
 * Collapse variants of one person into the shortest canonical form.
 * Search-result titles routinely glue a prefix onto the name ("EY Falguni
 * Nayar", "Wikipedia Falguni Nayar"), all of which are the same human.
 */
function mergeSubsetNames(list) {
  const tokensOf = (name) => new Set(nameKey(name).split('-').filter(Boolean));
  const isSubset = (a, b) => [...a].every((t) => b.has(t));

  const candidates = list
    .map((p) => ({ ...p, _toks: tokensOf(p.name) }))
    .sort((a, b) => a._toks.size - b._toks.size || b.score - a.score);

  const out = [];
  for (const cand of candidates) {
    // A one-token key is a surname on its own ("A. Gupta" -> {gupta}), which
    // is a subset of *every* Gupta. Merging on that collapsed Anil and Sunil
    // Gupta into a single row, so a bare surname is never a merge host.
    const host = out.find(
      (o) =>
        (o._toks.size > 1 && isSubset(o._toks, cand._toks)) ||
        (cand._toks.size > 1 && isSubset(cand._toks, o._toks))
    );
    if (host) {
      host.score += cand.score;
      host.designation = betterDesignation(host.designation, cand.designation);
      // The host is deliberately the SHORTEST form. Search titles glue
      // prefixes on ("EY Falguni Nayar"), and the extra word makes the
      // LinkedIn query miss and the profile-slug check fail.
      continue;
    }
    out.push(cand);
  }
  return out.map(({ _toks, ...p }) => p);
}

/** Readable page text for the optional LLM pass. */
function extractPageText(html) {
  const $ = cheerio.load(withSeparators(html));
  $('script, style, noscript, svg, iframe').remove();
  return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 30000);
}

module.exports = { extractLeaders, extractPageText, prepareDom, isDesignationLabel };
