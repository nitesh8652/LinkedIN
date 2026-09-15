/** Explicit live smoke test: public searches only, no LLM or paid search API. */
require('../src/env');
process.env.OPENAI_API_KEY = '';
process.env.SEARCH_PROVIDER = 'own';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withSearchConfig } = require('../src/search-config');
const { findLinkedInProfile } = require('../src/linkedin');
const { verifyDirectorOnLinkedIn } = require('../src/zaubacorp');
const { installSearchApi } = require('../src/search-api');
const { ownSearch } = require('../src/search');
const express = require('express');

(async () => {
  const app = express();
  installSearchApi(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const report = { checkedAt: new Date().toISOString(), provider: 'own', checks: [] };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.OWN_SEARCH_API_KEY) headers['X-API-KEY'] = process.env.OWN_SEARCH_API_KEY;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/search`, {
      method: 'POST', headers, body: JSON.stringify({ q: 'Sethu Madhavan PlasmaGen Biosciences linkedin', num: 10 }),
      signal: AbortSignal.timeout(35000),
    });
    const data = await response.json();
    assert.equal(response.status, 200, data.error);
    assert.ok(data.organic.some((r) => /linkedin\.com\/in\/sethu-madhavan-sankaran/.test(r.link)), 'Expected observed public profile');
    report.checks.push({ check: 'search API', count: data.organic.length, sources: data.search_metadata.sources, warnings: data.warnings });
    await withSearchConfig({ provider: 'own' }, async () => {
      const profile = await findLinkedInProfile('Sethu Madhavan', 'PlasmaGen Biosciences', 'COO', console.log);
      assert.match(profile || '', /linkedin\.com\/in\/sethu-madhavan-sankaran/);
      const registry = await verifyDirectorOnLinkedIn('Sethu Madhavan', 'PlasmaGen Biosciences', 'Director', console.log);
      assert.equal(registry.url, profile);
      report.checks.push({ check: 'website and registry LinkedIn verification', url: profile, confidence: registry.confidence });
      const previous = process.env.OWN_SEARCH_ENGINES;
      try {
        process.env.OWN_SEARCH_ENGINES = '';
        const searx = await ownSearch.search('Sethu Madhavan PlasmaGen Biosciences linkedin', {
          accept: (row) => /linkedin\.com\/in\/sethu-madhavan-sankaran/.test(row.url), log: console.log,
        });
        assert.ok(searx.results.some((row) => /linkedin\.com\/in\/sethu-madhavan-sankaran/.test(row.url)));
        assert.deepEqual(searx.sources, ['searxng']);
        report.checks.push({ check: 'Own Search through SearXNG', count: searx.results.length, sources: searx.sources, warnings: searx.warnings });
      } finally {
        if (previous === undefined) delete process.env.OWN_SEARCH_ENGINES;
        else process.env.OWN_SEARCH_ENGINES = previous;
      }
    });
    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.ok = false;
    report.error = error.message;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    const output = path.resolve(__dirname, '../outputs/own-search-live-check.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    await new Promise((resolve) => server.close(resolve));
  }
})();
