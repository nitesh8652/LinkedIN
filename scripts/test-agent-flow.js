/**
 * Orchestration regression test. Stubs the search, discover, crawler and
 * linkedin modules before agent.js requires them, so it exercises the routing
 * logic rather than the network.
 *
 * Guards the case that once silently zeroed out every LinkedIn URL: a crawl
 * that returns only untitled names must NOT suppress the LinkedIn-titles
 * fallback, which is the one source that arrives with a URL already attached.
 *
 * Run: node scripts/test-agent-flow.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', 'src');

const searchPath = require.resolve(path.join(ROOT, 'search.js'));
const crawlerPath = require.resolve(path.join(ROOT, 'crawler.js'));
const linkedinPath = require.resolve(path.join(ROOT, 'linkedin.js'));
const discoverPath = require.resolve(path.join(ROOT, 'discover.js'));

require.cache[searchPath] = { id: searchPath, filename: searchPath, loaded: true, exports: {
  searchWeb: async () => [],
  searchWithFallbackQueries: async () => [
    { url: 'https://in.linkedin.com/in/asha-rao', title: 'Asha Rao - Managing Director - Acme Industries | LinkedIn', snippet: 'Acme Industries' },
    { url: 'https://in.linkedin.com/in/bimal-shah', title: 'Bimal Shah - Chief Executive Officer - Acme Industries | LinkedIn', snippet: 'Acme Industries' },
  ],
  closeSearchBrowser: async () => {},
  serperStatus: () => ({ configured: true, active: true, credits: 999 }),
  verifySearchProvider: async () => ({ configured: true, ok: true, credits: 999 }),
}};

require.cache[discoverPath] = { id: discoverPath, filename: discoverPath, loaded: true, exports: {
  findOfficialWebsiteWithQueries: async () => ({ url: 'https://acme.example/', domain: 'acme.example', score: 18 }),
}};

// The crawl finds ONLY untitled names — the exact case that broke.
require.cache[crawlerPath] = { id: crawlerPath, filename: crawlerPath, loaded: true, exports: {
  crawlWebsiteForLeaders: async () => ({
    leaders: [
      { name: 'Vikram Desai', designation: '', score: 4 },
      { name: 'Priya Nair', designation: '', score: 3 },
      { name: 'Sunil Mehta', designation: '', score: 2 },
    ],
    pagesVisited: ['https://acme.example/'],
  }),
}};

require.cache[linkedinPath] = { id: linkedinPath, filename: linkedinPath, loaded: true, exports: {
  findLinkedInProfile: async () => null,   // lookup finds nothing for the guesses
}};

const { runAgent } = require(path.join(ROOT, 'agent.js'));

const job = {
  log: (m) => { if (/fallback|LinkedIn titles|Search:/.test(m)) console.log('   LOG ' + m); },
  setMeta: () => {}, setProgress: () => {}, onRow: () => {},
};

(async () => {
  const rows = await runAgent(['Acme Industries'], job);
  console.log('\n   rows:');
  for (const r of rows) {
    console.log(`   ${r.personName} | ${r.designation} | ${r.linkedinUrl || 'NULL'} | ${r.status}`);
  }
  const withUrl = rows.filter((r) => r.linkedinUrl).length;
  console.log(`\n   LinkedIn URLs found: ${withUrl}`);
  process.exit(withUrl >= 2 ? 0 : 1);
})();
