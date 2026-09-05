require('./env');
const { AsyncLocalStorage } = require('node:async_hooks');

const searchContext = new AsyncLocalStorage();

function resolveSearchConfig(options = {}) {
  const provider = options.provider ?? process.env.SEARCH_PROVIDER ?? 'serper';
  if (!['serper', 'searxng'].includes(provider)) {
    throw new Error('Search provider must be serper or searxng');
  }
  const rawUrl = options.searxngUrl ?? process.env.SEARXNG_URL ?? 'http://localhost:8080';
  let url;
  try { url = new URL(String(rawUrl).trim()); } catch {
    throw new Error('Enter a valid SearXNG instance URL (http:// or https://)');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('SearXNG URL must use HTTP or HTTPS without embedded credentials');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/search$/, '') + '/search';
  return Object.freeze({ provider, searxngUrl: url.href });
}

function withSearchConfig(options, callback) {
  return searchContext.run({ config: resolveSearchConfig(options), used: new Set() }, callback);
}

function currentSearchConfig() {
  return searchContext.getStore()?.config || resolveSearchConfig();
}

function noteSearchProvider(provider) {
  searchContext.getStore()?.used.add(provider);
}

function searchProviderLabel() {
  const label = currentSearchConfig().provider === 'searxng' ? 'SearXNG' : 'Serper (Google API)';
  return searchContext.getStore()?.used.has('scraped engines') ? `${label} + scraped fallback engines` : label;
}

module.exports = { resolveSearchConfig, withSearchConfig, currentSearchConfig, noteSearchProvider, searchProviderLabel };
