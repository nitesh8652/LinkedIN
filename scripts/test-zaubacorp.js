/**
 * ZaubaCorp fallback smoke test.
 *
 *   node scripts/test-zaubacorp.js "TIMES COMTRADE PRIVATE LIMITED"
 *
 * Exercises the fallback end-to-end: registry search -> company-name match ->
 * director extraction -> LinkedIn verification. Pass --no-linkedin to stop
 * after extraction (much faster, and spends no search credits per person).
 */

const {
  findDirectorsOnZaubaCorp,
  verifyDirectorOnLinkedIn,
  closeZaubaBrowser,
  matchCompanyName,
} = require('../src/zaubacorp');
const { closeSearchBrowser } = require('../src/search');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const skipLinkedIn = process.argv.includes('--no-linkedin');
const company = args[0] || 'TIMES COMTRADE PRIVATE LIMITED';

const log = (msg) => console.log(msg);

// Name-matching cases that must keep behaving, printed before the network work
// so a matcher regression is obvious without waiting for a crawl.
const MATCH_CASES = [
  ['BLUE TOKAI COFFEE ROASTER', 'BLUE TOKAI COFFEE ROASTERS PRIVATE LIMITED', true],
  ['TIMES COMTRADE PRIVATE LIMITED', 'TIMES COMTRADE PRIVATE LIMITED', true],
  ['TIMES COMTRADE PRIVATE LIMITED', 'TIMES GREEN POWER PRIVATE LIMITED', false],
  ['TIMES COMTRADE PRIVATE LIMITED', 'TRUE VALUE COMTRADE PRIVATE LIMITED', false],
  ['Tata Consultancy Services', 'TATA CONSULTANCY SERVICES LIMITED', true],
  ['Tata Consultancy Services', 'TATA MOTORS LIMITED', false],
];

(async () => {
  console.log('--- company name matching ---');
  let failures = 0;
  for (const [input, candidate, expected] of MATCH_CASES) {
    const m = matchCompanyName(input, candidate);
    const ok = m.accepted === expected;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${input}  ~  ${candidate}  -> ` +
        `${m.accepted ? 'accept' : 'reject'} (${m.score}, ${m.confidence})`
    );
  }
  console.log(failures ? `${failures} matcher case(s) FAILED` : 'all matcher cases passed');

  console.log(`\n--- ZaubaCorp lookup: ${company} ---`);
  const result = await findDirectorsOnZaubaCorp(company, log);
  console.log(JSON.stringify({ ...result, directors: undefined }, null, 2));
  console.table(result.directors);

  if (result.ok && !skipLinkedIn) {
    console.log('\n--- LinkedIn verification ---');
    for (const d of result.directors) {
      const v = await verifyDirectorOnLinkedIn(d.name, company, d.designation, log);
      console.log(`${d.name} (${d.designation}) -> ${v.url || 'NULL'} [${v.confidence}] ${v.reason}`);
    }
  }

  await closeZaubaBrowser();
  await closeSearchBrowser();
})().catch(async (err) => {
  console.error('FATAL', err);
  await closeZaubaBrowser();
  await closeSearchBrowser();
  process.exit(1);
});
