/**
 * Offline regression tests for the matching rules that decide whether a row
 * comes back populated or NULL. Run: node scripts/test-rules.js
 */

const { isValidPersonName, companyTokensOf } = require('../src/person');
const { domainCore, isSocialOrDirectory, scoreDomain } = require('../src/discover');
const { brandTokens } = require('../src/normalize');

let failed = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${got}, want ${want})`}`);
}

// Indian initial conventions, both orders.
check('accept "M.K. Sharma"', isValidPersonName('M.K. Sharma'), true);
check('accept "N.R. Narayana Murthy"', isValidPersonName('N.R. Narayana Murthy'), true);
check('accept "Krithivasan K."', isValidPersonName('Krithivasan K.'), true);
check('accept "Ramesh B."', isValidPersonName('Ramesh B.'), true);

// Eponymous firms: the founder shares a word with the company.
const bajaj = companyTokensOf('Bajaj Auto Limited');
check('accept "Rajiv Bajaj" at Bajaj Auto', isValidPersonName('Rajiv Bajaj', { companyTokens: bajaj }), true);
check(
  'accept "Anand Mahindra" at Mahindra',
  isValidPersonName('Anand Mahindra', { companyTokens: companyTokensOf('Mahindra & Mahindra Ltd') }),
  true
);

// ...but the brand itself, or the brand glued to the front, is not a person.
const nykaa = companyTokensOf('Nykaa');
check('reject "Bajaj Auto"', isValidPersonName('Bajaj Auto', { companyTokens: bajaj }), false);
check('reject "Nykaa Falguni Nayar"', isValidPersonName('Nykaa Falguni Nayar', { companyTokens: nykaa }), false);
check('reject "Nykaa Beauty"', isValidPersonName('Nykaa Beauty', { companyTokens: nykaa }), false);
check('reject "A. B."', isValidPersonName('A. B.'), false);

// Domain core survives suffixes outside the old hardcoded whitelist.
check('domainCore abc.tech', domainCore('abc.tech'), 'abc');
check('domainCore abc.biz', domainCore('abc.biz'), 'abc');
check('domainCore abc.co.in', domainCore('abc.co.in'), 'abc');
check('domainCore tcs.com', domainCore('tcs.com'), 'tcs');
check('domainCore in.abc.com', domainCore('in.abc.com'), 'abc');

// Blocklist matches whole labels, not substrings.
check('vertex.com is not social', isSocialOrDirectory('https://vertex.com/'), false);
check('sunshine.com is not social', isSocialOrDirectory('https://sunshine.com/'), false);
check('x.com is social', isSocialOrDirectory('https://x.com/foo'), true);
check('linkedin.com is social', isSocialOrDirectory('https://www.linkedin.com/in/foo'), true);
check('zaubacorp.com is a directory', isSocialOrDirectory('https://www.zaubacorp.com/company/x'), true);

// Abbreviated trading names.
check('bhel.com scores as acronym', scoreDomain('bhel', brandTokens('Bharat Heavy Electricals Limited')).kind, 'acronym-prefix');
check('koel.in scores as acronym', scoreDomain('koel', brandTokens('Kirloskar Oil Engines Limited')).kind, 'acronym-prefix');
check(
  'tcsion.com does not',
  scoreDomain('tcsion', brandTokens('Tata Consultancy Services')).kind.startsWith('acronym'),
  false
);

// --- LinkedIn candidate matching -------------------------------------------
const { validateLinkedInCandidate } = require('../src/linkedin');

const THRESHOLD = 10;
const CO = 'Plasmagen Biosciences Pvt Ltd';
const TITLE = 'Vinod Nahar - Chairman and Director - Plasmagen Biosciences Pvt. Ltd. | LinkedIn';
const accepts = (url, title = TITLE, name = 'Vinod Nahar', company = CO) =>
  validateLinkedInCandidate(url, title, name, company) >= THRESHOLD;

// The slug spelling the surname out is the easy case.
check('match slug /in/vinod-nahar', accepts('https://in.linkedin.com/in/vinod-nahar'), true);

// Abbreviated and custom slugs: identity proved by the title instead. These
// were hard rejections before, and are the common shape of a real profile.
check('match abbreviated slug /in/vinod-n-8a4b21', accepts('https://in.linkedin.com/in/vinod-n-8a4b21'), true);
check('match opaque slug /in/vn-472913', accepts('https://in.linkedin.com/in/vn-472913'), true);
check(
  'match honorific in title',
  accepts('https://in.linkedin.com/in/vn-472913', 'Dr. Vinod Nahar - Chairman - Plasmagen Biosciences | LinkedIn'),
  true
);
check(
  'match 3-token name, opaque slug',
  accepts('https://in.linkedin.com/in/rk-9182', 'Rajesh Kumar Sharma - MD - Acme Foods | LinkedIn', 'Rajesh Kumar Sharma', 'Acme Foods Ltd'),
  true
);

// The title path must not become a way in for the wrong person.
check(
  'reject right name at wrong employer',
  accepts('https://in.linkedin.com/in/vinod-x-1122', 'Vinod Nahar - Founder - Unrelated Ltd | LinkedIn'),
  false
);
check(
  'reject different surname',
  accepts('https://in.linkedin.com/in/vinod-gupta', 'Vinod Gupta - CEO - Other Corp | LinkedIn'),
  false
);
check(
  'reject listicle where the name is buried',
  accepts('https://in.linkedin.com/in/someone-else-99', 'Top leaders at Plasmagen Biosciences: Vinod Nahar, Asha Rao | LinkedIn'),
  false
);
check('reject a company page URL', accepts('https://www.linkedin.com/company/plasmagen'), false);

console.log(failed ? `\n${failed} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
