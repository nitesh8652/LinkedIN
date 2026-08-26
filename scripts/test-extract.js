/**
 * Offline regression test for name/designation extraction.
 * Run: node scripts/test-extract.js
 */

const { extractLeaders } = require('../src/extract');
const { isValidPersonName, cleanName, normalizeDesignation } = require('../src/person');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
};

// --- names that must never be accepted (all were produced by the old parser)
for (const junk of [
  'Board', 'ries', 'staying a', 'Search', 'Help', 'Our Team', 'Read More',
  'Board Of Directors', 'Quick Links', 'Annual Report', 'r-led firm',
  'Visit our', 'Nykaa Beauty', 'FSN E-commerce',
]) {
  check(`reject "${junk}"`, isValidPersonName(cleanName(junk), { companyTokens: ['nykaa'] }), false);
}

// --- names that must be accepted
for (const name of [
  'Rajesh Kumar Sharma', 'Priya N. Menon', 'K. Krithivasan', 'MUKESH AMBANI',
  'Jose van der Berg', 'Al-Noor Ramji', 'Mark Rose',
]) {
  check(`accept "${name}"`, isValidPersonName(cleanName(name)), true);
}

// --- honorifics and glued title fragments are stripped
check('strip honorific', cleanName('Mr. Anil B. Gupta'), 'Anil B. Gupta');
check('strip title fragment', cleanName('Vedika Bhandarkar Non-Executive'), 'Vedika Bhandarkar');
check('collapse repeat', cleanName('K. Krithivasan K. Krithivasan'), 'K. Krithivasan');

// --- designations stop where the prose starts
check(
  'trim bio prose',
  normalizeDesignation('Founder & CFO Bio Nikhil Is An Astute and'),
  'Founder & CFO'
);
check('canonical case', normalizeDesignation('managing director'), 'Managing Director');

// --- structural extraction
const page = `<html><body>
  <nav><h4>Search</h4><h4>Help</h4><div><h4>Board</h4><span>Contact our director</span></div></nav>
  <div class="card"><h3>Rajesh Kumar Sharma</h3><p>Managing Director</p></div>
  <div>We pride ourselves on staying ahead of the competition as a director-led firm.</div>
  <div>Visit our Directories of industries and sectors, director listings.</div>
  <section><h3>Priya N. Menon</h3><span>Chief Financial Officer</span></section>
  <ul><li>Mr. Anil B. Gupta, Independent Director</li>
      <li>Smt. Kavita Rao - Company Secretary</li>
      <li>Vedika Bhandarkar, Non-Executive Independent Director</li></ul>
  <p>Chairman: Suresh Narayan Iyer</p>
  <footer><p>Our Team of Directors</p></footer>
</body></html>`;

const people = extractLeaders(page, 'Acme Industries Pvt Ltd');
check(
  'extracted people',
  people.map((p) => `${p.name} | ${p.designation}`).sort(),
  [
    'Anil B. Gupta | Independent Director',
    'Kavita Rao | Company Secretary',
    'Priya N. Menon | Chief Financial Officer',
    'Rajesh Kumar Sharma | Managing Director',
    'Suresh Narayan Iyer | Chairman',
    'Vedika Bhandarkar | Independent Director',
  ]
);

// --- one person written several ways collapses to the canonical form
const variants = extractLeaders(
  `<html><body>
     <p>Nykaa Falguni Nayar - Founder</p>
     <p>Falguni Nayar, Founder and CEO</p>
     <p>Wikipedia Falguni Nayar - Chairperson</p>
   </body></html>`,
  'Nykaa'
);
check('dedupe name variants', variants.map((p) => p.name), ['Falguni Nayar']);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
