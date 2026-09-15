require('./env');
const { currentSearchConfig } = require('./search-config');

const serpapiKey = () => String(process.env.SERPAPI_API_KEY || '').trim();
const serpapiStatus = () => ({ configured: Boolean(serpapiKey()) });

function unavailable(message) {
  return Object.assign(new Error(message), { code: 'SEARCH_UNAVAILABLE' });
}

/** Google results only: never forward this key to a fallback provider. */
async function runSerpapi(query, { signal } = {}) {
  if (!['serpapi', 'hybrid'].includes(currentSearchConfig().provider)) {
    throw unavailable('SerpApi is disabled for the selected search provider');
  }
  if (!serpapiKey()) throw unavailable('SERPAPI_API_KEY not set. Add it to .env and restart the server');

  const url = new URL('https://serpapi.com/search.json');
  url.search = new URLSearchParams({
    engine: 'google', q: query, api_key: serpapiKey(),
    gl: String(process.env.SERPAPI_GL || 'in').trim(),
    hl: String(process.env.SERPAPI_HL || 'en').trim(),
  }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      throw unavailable(`SerpApi key rejected (HTTP ${res.status}). Check SERPAPI_API_KEY`);
    }
    if (res.status === 429) {
      throw unavailable('SerpApi search quota exhausted or rate limited (HTTP 429). Check your account or retry later');
    }
    if (!res.ok) throw unavailable(`SerpApi HTTP ${res.status}. Retry the connection test later`);
    let data;
    try { data = await res.json(); } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw unavailable('SerpApi did not return valid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw unavailable('Invalid SerpApi response');
    }
    const status = data.search_metadata?.status;
    // SerpApi reports Google's legitimate empty searches as Success + error.
    const empty = status === 'Success' && (
      /^fully empty$/i.test(data.search_information?.organic_results_state || '') ||
      /^Google hasn't returned any results for this query\.?$/i.test(data.error || '')
    );
    if ((data.error && !empty) || (status && status !== 'Success')) {
      // Do not expose raw API/network errors: they may contain the request URL/key.
      if (/invalid.*key|unauthorized|forbidden/i.test(data.error || '')) {
        throw unavailable('SerpApi key rejected. Check SERPAPI_API_KEY');
      }
      if (/run out of searches|quota|rate limit/i.test(data.error || '')) {
        throw unavailable('SerpApi search quota exhausted or rate limited. Check your account or retry later');
      }
      throw unavailable('SerpApi could not complete this search. Retry the connection test later');
    }
    if (data.organic_results !== undefined && !Array.isArray(data.organic_results)) {
      throw unavailable('Invalid SerpApi response: organic_results must be an array');
    }
    if (!status && !Array.isArray(data.organic_results) && !data.knowledge_graph && !data.answer_box) {
      throw unavailable('Invalid SerpApi response: missing search results');
    }

    const raw = [];
    const add = (link, title, snippet) => {
      if (typeof link === 'string') raw.push({
        href: link, title: typeof title === 'string' ? title : '',
        snippet: typeof snippet === 'string' ? snippet : '',
      });
    };
    add(data.knowledge_graph?.website, data.knowledge_graph?.title, data.knowledge_graph?.description);
    add(data.answer_box?.link, data.answer_box?.title, data.answer_box?.snippet);
    for (const result of data.organic_results || []) {
      if (!result || typeof result !== 'object') continue;
      add(result.link, result.title, result.snippet);
      for (const kind of ['inline', 'expanded']) {
        if (!Array.isArray(result.sitelinks?.[kind])) continue;
        for (const link of result.sitelinks[kind]) add(link?.link, link?.title, link?.snippet);
      }
    }
    return raw;
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
    if (err.code === 'SEARCH_UNAVAILABLE') throw err;
    if (controller.signal.aborted) throw unavailable('SerpApi timed out after 30 seconds');
    throw unavailable('Cannot reach SerpApi. Check the network connection and retry');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runSerpapi, serpapiStatus };
