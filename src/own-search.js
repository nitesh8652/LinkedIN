/** No-key metasearch. Only fixed public search endpoints and the configured
 * SearXNG instance are queried; paid provider adapters are never called. */
require('./env');
const cheerio = require('cheerio');
const { setTimeout: delay } = require('node:timers/promises');
const { currentSearchConfig } = require('./search-config');

const ENGINES = {
  duckduckgo: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  brave: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
  bing: (q) => `https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&gbv=1`,
};
const text = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const unavailable = (message) => Object.assign(new Error(message), { code: 'SEARCH_UNAVAILABLE' });
const cancelled = () => new DOMException('Search cancelled', 'AbortError');
const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));

function configuredEngines() {
  const names = [...new Set(String(process.env.OWN_SEARCH_ENGINES ?? 'duckduckgo,brave,bing')
    .split(',').map((s) => s.trim()).filter(Boolean))];
  if (names.some((name) => !Object.hasOwn(ENGINES, name))) {
    throw unavailable('OWN_SEARCH_ENGINES supports duckduckgo, brave, bing and google');
  }
  return names;
}

/** Unwrap only known search redirects, keeping case-sensitive paths and
 * meaningful query strings. Never manufacture a LinkedIn profile slug. */
function resultUrl(href, base) {
  try {
    let url = new URL(href, base);
    if (/(^|\.)duckduckgo\.com$/.test(url.hostname) && url.searchParams.has('uddg')) {
      url = new URL(url.searchParams.get('uddg'));
    } else if (/(^|\.)google\.com$/.test(url.hostname) && url.pathname === '/url') {
      url = new URL(url.searchParams.get('q') || url.searchParams.get('url'));
    } else if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname === '/ck/a') {
      const target = url.searchParams.get('u') || '';
      url = new URL(target.startsWith('a1') ? Buffer.from(target.slice(2), 'base64url').toString() : target);
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (/(^|\.)(duckduckgo\.com|search\.brave\.com|bing\.com|google\.com)$/.test(url.hostname)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(gclid|fbclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return null; }
}

function parseSearchPage(engine, html, base) {
  const $ = cheerio.load(html, { xml: engine === 'bing' });
  const rows = [];
  const add = (href, title, snippet) => {
    const url = resultUrl(href, base);
    if (url && text(title)) rows.push({ url, title: text(title), snippet: text(snippet), sources: [engine] });
  };
  if (engine === 'bing') {
    $('item').each((_, el) => add($(el).find('link').text(), $(el).find('title').text(), $(el).find('description').text()));
  } else if (engine === 'duckduckgo') {
    $('.result').each((_, el) => {
      const box = $(el);
      if (box.hasClass('result--ad')) return;
      const a = box.find('.result__a').first();
      add(a.attr('href'), a.text(), box.find('.result__snippet').text());
    });
  } else if (engine === 'brave') {
    $('.snippet').each((_, el) => {
      const box = $(el);
      const title = box.find('.search-snippet-title, .title').first();
      const a = title.closest('a[href]');
      add(a.attr('href'), title.text(), box.find('.generic-snippet, .snippet-description').first().text());
    });
  } else if (engine === 'google') {
    $('h3').each((_, el) => {
      const heading = $(el);
      const a = heading.closest('a[href]');
      const box = heading.closest('.MjjYud, .g, .Gx5Zad');
      add(a.attr('href'), heading.text(), box.find('.VwiC3b, .IsZvec, .aCOpRe').first().text());
    });
  }
  if (rows.length) return rows;
  // An interstitial or changed markup is an outage, never a valid empty SERP.
  const body = text($.root().text());
  if (/no results found|did not match any documents|there are no results|no web results found/i.test(body)) return [];
  if (/captcha|verify you are human|unusual traffic|anomaly-modal|enablejs|challenge-form/i.test(html)) {
    throw unavailable('Search engine requires a browser check or CAPTCHA');
  }
  throw unavailable('Search engine returned no readable results (blocked or changed markup)');
}

function mergeResults(rows) {
  const seen = new Map();
  for (const row of rows) {
    const url = resultUrl(row.url);
    if (!url) continue;
    const parsed = new URL(url);
    // Regional LinkedIn hosts and tracking parameters describe the same page.
    const key = /(^|\.)linkedin\.com$/.test(parsed.hostname)
      ? `linkedin.com${parsed.pathname.replace(/\/$/, '').toLowerCase()}` : url.replace(/\/$/, '');
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, { url, title: text(row.title), snippet: text(row.snippet), sources: [...(row.sources || [])] });
    } else {
      if (text(row.title).length > previous.title.length) previous.title = text(row.title);
      const snippet = text(row.snippet);
      if (snippet && !previous.snippet.includes(snippet)) previous.snippet = text(`${previous.snippet} ${snippet}`);
      previous.sources = [...new Set([...previous.sources, ...(row.sources || [])])];
    }
  }
  return [...seen.values()];
}

/** Factory makes provider scheduling testable without live internet traffic. */
function createOwnSearch({ runSearxng, queryConstraints, isRelevant, fetchImpl = (...args) => fetch(...args),
  now = Date.now, intervalMs = 800, timeoutMs = 15000, cacheTtlMs = 600000, fallbackDelayMs = 1500 } = {}) {
  const states = new Map();
  const cache = new Map();
  let active = 0;
  function state(key) {
    if (!states.has(key)) {
      if (states.size >= 500) states.delete(states.keys().next().value);
      states.set(key, { nextStart: 0, until: 0, error: '', lastSuccess: null });
    }
    return states.get(key);
  }
  function sources(engines) {
    return [{ name: 'searxng', key: currentSearchConfig().searxngUrl + '|' + engines },
      ...configuredEngines().map((name) => ({ name, key: name }))];
  }
  async function direct(name, query, signal) {
    const response = await fetchImpl(ENGINES[name](query), {
      signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/rss+xml,application/xml' },
    });
    if (!response.ok || response.status === 202) throw unavailable(`Search engine HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw unavailable('Search response exceeded 4 MB');
      chunks.push(chunk);
    }
    return parseSearchPage(name, Buffer.concat(chunks).toString('utf8'), ENGINES[name](query));
  }
  async function search(query, { accept = null, limit = 15, searxngEngines = '', log = null, signal } = {}) {
    if (currentSearchConfig().provider !== 'own') throw unavailable('Own Search is disabled for the selected provider');
    if (signal?.aborted) throw cancelled();
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('q must contain 1 to 1000 characters');
    query = query.trim();
    limit = bounded(limit, 15, 1, 50);
    const engines = searxngEngines || process.env.OWN_SEARCH_SEARXNG_ENGINES || 'google,bing,duckduckgo,brave';
    const providers = sources(engines);
    const key = JSON.stringify([providers.map((s) => s.key), query]);
    const hit = cache.get(key);
    if (hit?.expires > now() && (!accept || hit.value.results.some(accept))) {
      const value = structuredClone(hit.value);
      if (accept) value.results.sort((a, b) => Number(accept(b)) - Number(accept(a)));
      return { ...value, results: value.results.slice(0, limit), cached: true };
    }
    cache.delete(key);
    if (active >= 4) throw unavailable('Own Search is busy; retry shortly');
    active++;
    const start = now();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const constraints = queryConstraints(query);
    const warnings = [];
    const collected = [];
    const responding = [];
    const outstanding = new Set(providers.map((s) => s.key));
    let pending = providers.length;
    let successes = 0;
    let retryableFailure = false;
    let finished = false;
    let timer;
    let fallbackTimer;
    let releaseFallbacks;
    const fallbackReady = new Promise((resolve) => { releaseFallbacks = resolve; });
    const fallbackDelay = Math.max(0, Math.min(5000, Number(process.env.OWN_SEARCH_FALLBACK_DELAY_MS ?? fallbackDelayMs) || 0));
    if (fallbackDelay === 0) releaseFallbacks();
    else fallbackTimer = setTimeout(releaseFallbacks, fallbackDelay);
    try {
      return await new Promise((resolve, reject) => {
        const complete = (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          clearTimeout(fallbackTimer);
          releaseFallbacks();
          signal?.removeEventListener('abort', onAbort);
          controller.abort();
          let results = mergeResults(collected);
          if (accept) results.sort((a, b) => Number(accept(b)) - Number(accept(a)));
          if (error) return reject(error);
          if (!successes || (!results.some(accept || (() => true)) && warnings.length)) {
            const err = unavailable(`Own Search temporarily unavailable. ${warnings.join('; ')}`);
            err.retryWithRemainingEngines = successes > 0 || retryableFailure;
            return reject(err);
          }
          const value = { results, sources: responding, warnings: [...new Set(warnings)], cached: false, elapsedMs: now() - start };
          if (results.length) {
            if (cache.size >= 500) cache.delete(cache.keys().next().value);
            cache.set(key, { expires: now() + (warnings.length ? Math.min(cacheTtlMs, 30000) : cacheTtlMs), value: structuredClone(value) });
          }
          resolve({ ...value, results: results.slice(0, limit) });
        };
        const onAbort = () => complete(cancelled());
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          for (const sourceKey of outstanding) {
            const health = state(sourceKey);
            health.error = 'Request timed out'; health.until = now() + 60000;
          }
          warnings.push('Search deadline reached'); complete();
        },
          bounded(process.env.OWN_SEARCH_TIMEOUT_MS, timeoutMs, 50, 30000));
        providers.forEach(({ name, key: sourceKey }) => {
          const health = state(sourceKey);
          const task = async () => {
            // Give SearXNG a head start so a healthy response avoids duplicate
            // requests to the same upstream engines through two routes.
            if (name !== 'searxng') await fallbackReady;
            if (combined.aborted) throw cancelled();
            if (health.until > now()) throw unavailable(`${health.error} (cooling down)`);
            const scheduled = Math.max(now(), health.nextStart);
            health.nextStart = scheduled + intervalMs;
            if (scheduled > now()) await delay(scheduled - now(), undefined, { signal: combined });
            if (combined.aborted) throw cancelled();
            const raw = name === 'searxng'
              ? (await runSearxng(query, { engines, log, signal: combined,
                onWarning: (warning) => { if (!finished) warnings.push(`searxng/${warning}`); },
              })).map((r) => ({ ...r, sources: ['searxng'] }))
              : await direct(name, query, combined);
            const relevant = raw.filter((r) => isRelevant(r, constraints, { minTokenCoverage: 0.6 }) ||
              (accept && isRelevant(r, constraints, { trusted: true }) && accept(r)));
            if (raw.length && !relevant.length) {
              throw Object.assign(unavailable('Engine returned unrelated results for this query'), {
                retryWithRemainingEngines: true,
              });
            }
            return relevant;
          };
          Promise.resolve().then(task).then((rows) => {
            if (finished) return;
            outstanding.delete(sourceKey);
            successes++;
            health.error = ''; health.until = 0; health.lastSuccess = now();
            responding.push(name);
            collected.push(...rows);
            if (log) log(`      [own/${name}] ${rows.length} relevant result(s)`);
            pending--;
            const merged = mergeResults(collected);
            if ((accept ? merged.some(accept) : merged.length >= Math.min(5, limit)) || !pending) complete();
            else if (name === 'searxng') { clearTimeout(fallbackTimer); releaseFallbacks(); }
          }, (error) => {
            if (finished) return;
            outstanding.delete(sourceKey);
            const reason = error.code === 'SEARCH_UNAVAILABLE' ? error.message
              : error.name === 'AbortError' ? 'Request timed out' : 'Cannot reach search source';
            // A partial SearXNG outage already suspends individual engines in
            // runSearxng. Do not bench healthy engines along with them. A
            // relevance miss also applies to this query, not the whole source.
            if (error.retryWithRemainingEngines) retryableFailure = true;
            else if (health.until <= now()) {
              health.error = reason;
              health.until = now() + (/captcha|429|403|202/i.test(reason) ? 300000 : 60000);
            }
            if (name === 'searxng') { clearTimeout(fallbackTimer); releaseFallbacks(); }
            const warning = `${name}: ${reason}`;
            warnings.push(warning);
            if (log) log(`      [own] ${warning}`);
            pending--;
            if (!pending) complete();
          });
        });
      });
    } finally { active--; clearTimeout(timer); clearTimeout(fallbackTimer); }
  }
  function status() {
    const engines = process.env.OWN_SEARCH_SEARXNG_ENGINES || 'google,bing,duckduckgo,brave';
    return { provider: 'own', requiresPaidKey: false, activeRequests: active, cacheEntries: cache.size,
      engines: sources(engines).map(({ name, key }) => {
        const health = state(key);
        return { name, status: health.until > now() ? 'cooldown' : health.lastSuccess ? 'available' : 'untested',
          lastSuccess: health.lastSuccess, retryAfterMs: Math.max(0, health.until - now()),
          ...(health.until > now() ? { error: health.error } : {}) };
      }) };
  }
  return { search, status };
}

module.exports = { createOwnSearch, parseSearchPage, resultUrl, mergeResults };
