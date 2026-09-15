const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installSearchApi } = require('../src/search-api');
const { ownSearch } = require('../src/search');
const { currentSearchConfig } = require('../src/search-config');

test('JSON API provides Serper and SerpApi organic fields, validates input, and scopes auth to search', async (t) => {
  const app = express();
  installSearchApi(app);
  app.get('/ordinary', (req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const oldKey = process.env.OWN_SEARCH_API_KEY;
  delete process.env.OWN_SEARCH_API_KEY;
  t.after(() => { if (oldKey === undefined) delete process.env.OWN_SEARCH_API_KEY; else process.env.OWN_SEARCH_API_KEY = oldKey; });
  const requests = [];
  t.mock.method(ownSearch, 'search', async (q, options) => {
    assert.equal(currentSearchConfig().provider, 'own');
    requests.push({ q, options });
    return { results: [{ url: 'https://in.linkedin.com/in/asha-rao', title: 'Asha Rao - Acme', snippet: 'Director', sources: ['duckduckgo'] }], sources: ['duckduckgo'], warnings: ['brave: rate limited'], cached: false };
  });
  const health = await (await fetch(`${root}/api/search/health`)).json();
  assert.equal(health.requiresPaidKey, false);
  assert.equal(requests.length, 0);
  for (const [route, options] of [
    ['/api/search?q=Asha%20Rao&num=3'],
    ['/search.json?engine=google&q=Asha%20Rao&num=3'],
    ['/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'Asha Rao', num: 3 }) }],
    ['/api/search', { method: 'POST', body: new URLSearchParams({ q: 'Asha Rao', num: '3' }) }],
  ]) {
    const response = await fetch(root + route, options);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.search_metadata.provider, 'own');
    assert.equal(data.search_metadata.status, 'Success');
    assert.deepEqual(data.organic, data.organic_results);
    assert.equal(data.organic[0].position, 1);
    assert.equal(data.organic[0].link, data.results[0].url);
    assert.equal(requests.at(-1).options.limit, 3);
    assert.equal(data.warnings.length, 1);
  }
  for (const query of ['', '?q=', '?q=test&num=0', '?q=test&num=2.5', '?q=test&num=500', '?q=test&engine=maps', '?q=test&start=10', '?q=test&searxngUrl=http://unsafe.test', '?q=a&q=b']) {
    assert.equal((await fetch(root + '/api/search' + query)).status, 400);
  }
  assert.equal(requests.length, 4);
  process.env.OWN_SEARCH_API_KEY = 'private-local-test-key';
  assert.equal((await fetch(root + '/api/search?q=test')).status, 401);
  assert.equal((await fetch(root + '/api/search/health')).status, 401);
  assert.equal((await fetch(root + '/ordinary')).status, 200);
  assert.equal((await fetch(root + '/search?q=test')).status, 404);
  for (const headers of [{ 'X-API-KEY': 'private-local-test-key' }, { Authorization: 'Bearer private-local-test-key' }]) {
    assert.equal((await fetch(root + '/api/search?q=test', { headers })).status, 200);
  }
  t.mock.method(ownSearch, 'search', async () => { throw Object.assign(new Error('All search sources unavailable'), { code: 'SEARCH_UNAVAILABLE' }); });
  const unavailable = await fetch(root + '/search.json?q=test&api_key=private-local-test-key');
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).search_metadata.status, 'Error');
});
