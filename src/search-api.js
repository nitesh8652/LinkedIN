const express = require('express');
const { timingSafeEqual, randomUUID } = require('node:crypto');
const { ownSearch } = require('./search');
const { withSearchConfig } = require('./search-config');

function apiAccess(req, res, next) {
  const key = String(process.env.OWN_SEARCH_API_KEY || '');
  const remote = req.socket.remoteAddress || '';
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  if (!key && loopback) return next();
  const supplied = String(req.get('X-API-KEY') || req.get('Authorization')?.replace(/^Bearer /i, '') || req.query.api_key || '');
  if (key && Buffer.byteLength(key) === Buffer.byteLength(supplied) &&
      timingSafeEqual(Buffer.from(key), Buffer.from(supplied))) return next();
  return res.status(401).json({ error: key ? 'Valid search API key required' : 'Search API is local only. Set OWN_SEARCH_API_KEY to allow remote clients' });
}

function installSearchApi(app) {
  const router = express.Router();
  router.get('/api/search/health', apiAccess, (req, res) => {
    try { res.json(withSearchConfig({ provider: 'own' }, () => ownSearch.status())); }
    catch (err) { res.status(503).json({ error: err.message }); }
  });
  const search = async (req, res) => {
    const input = req.method === 'GET' ? req.query : req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        typeof input.q !== 'string' || !input.q.trim() || input.q.length > 1000) {
      return res.status(400).json({ error: 'q must contain 1 to 1000 characters' });
    }
    const num = Number(input.num ?? input.limit ?? 10);
    if (!Number.isInteger(num) || num < 1 || num > 50) return res.status(400).json({ error: 'num must be an integer from 1 to 50' });
    const unsupported = Object.keys(input).filter((key) => !['q', 'num', 'limit', 'api_key', 'engine'].includes(key));
    if (unsupported.length || (input.engine && !['google', 'own'].includes(input.engine))) {
      return res.status(400).json({ error: 'Supported parameters: q, num (or limit), api_key, engine=google|own. Results are metasearch; locale, pagination and verticals are not implemented' });
    }
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    const started = Date.now();
    try {
      const data = await withSearchConfig({ provider: 'own' }, () => ownSearch.search(input.q, { limit: num, signal: controller.signal }));
      if (controller.signal.aborted) return;
      const organic = data.results.map((row, index) => ({ title: row.title, link: row.url, snippet: row.snippet, position: index + 1, sources: row.sources }));
      res.json({ searchParameters: { q: input.q.trim(), num, engine: 'own' },
        search_metadata: { id: randomUUID(), status: 'Success', provider: 'own', cached: data.cached,
          total_time_taken: (Date.now() - started) / 1000, sources: data.sources },
        organic, organic_results: organic, results: data.results, warnings: data.warnings });
    } catch (err) {
      if (controller.signal.aborted) return;
      res.status(503).json({ search_metadata: { status: 'Error', provider: 'own' }, code: 'SEARCH_UNAVAILABLE', error: err.message });
    } finally { res.removeListener('close', abort); }
  };
  router.get(['/api/search', '/search.json'], apiAccess, search);
  router.post(['/api/search', '/search'], apiAccess, express.json({ limit: '16kb' }),
    express.urlencoded({ extended: false, limit: '16kb' }), search);
  app.use(router);
}

module.exports = { installSearchApi };
