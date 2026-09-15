const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  canonicalProfileUrl, parseLinkedInPeopleHtml, buildLinkedInQueries, createLinkedInDirectClient,
} = require('../src/linkedin-direct');

const SEARCH_URL = 'https://www.linkedin.com/search/results/people/?keywords=acme';
const card = ({ name = 'Asha Rao', slug = 'asha-rao', headline = 'Managing Director at Acme Foods', summary = '', url } = {}) => `
  <li class="search-result__occluded-item"><div class="reusable-search__result-container"><div class="entity-result">
    <a href="${url || `/in/${slug}?trackingId=123`}" class="photo"><img alt="${name}"></a>
    <div class="entity-result__title-text"><a href="${url || `/in/${slug}?trackingId=123`}"><span aria-hidden="true">${name}</span><span class="visually-hidden">${name}</span></a><span class="entity-result__badge"> • 2nd</span></div>
    <div class="entity-result__primary-subtitle">${headline}</div>
    <p class="entity-result__summary">${summary}</p><button>Connect</button>
  </div></div></li>`;
const page = (cards = card()) => `<html><body><header>Acme Foods Director search</header><input value="Acme Foods director"><main><ul>${cards}</ul></main></body></html>`;
const empty = '<html><body><div class="search-reusables__no-results">No results found</div></body></html>';
// Structure observed in the signed-in workspace layout; generated classes are
// intentionally omitted. Empty overlay links and the name link share a target.
const workspaceCard = ({ name = 'Asha Rao', slug = 'asha-rao', headline = 'Director at Acme Foods', extra = '', nameSlug = slug } = {}) => `
  <div role="listitem"><div><a href="/in/${slug}/"></a><div><a href="/in/${slug}/"></a><div>
    <a href="/in/${slug}/"><figure><img alt="${name}"></figure></a>
    <div><a href="/in/${slug}/"></a><p><a href="/in/${slug}/"></a><a href="/in/${nameSlug}/">${name}</a><span> &bull; 3rd+</span></p>
      <div><p><span>${headline}</span></p></div><div><p><span>Hyderabad, Telangana, India</span></p></div>${extra}</div>
    <div><a href="/preload/search-custom-invite/" aria-label="Invite ${name} to connect">Connect</a></div>
  </div></div></div></div>`;
const workspacePage = (cards = workspaceCard(), rightRail = '') => `<html><body>
  <header>Acme Foods director <a href="/in/logged-in-account/">Signed In Account</a></header><input value="Acme Foods director">
  <main id="workspace"><div data-testid="lazy-column"><div><div role="list"><div>${cards}</div></div></div></div>
  <div data-testid="lazy-column"><div id="SearchResults_SearchRightRail">${rightRail}</div></div></main></body></html>`;

test('canonical profile URLs are exact LinkedIn hosts, HTTP(S), and in paths only', () => {
  assert.equal(canonicalProfileUrl('https://in.linkedin.com/in/asha-rao/?tracking=1#top'), 'https://www.linkedin.com/in/asha-rao');
  assert.equal(canonicalProfileUrl('/in/asha-rao'), 'https://www.linkedin.com/in/asha-rao');
  for (const bad of ['javascript:alert(1)', 'https://linkedin.com.evil.test/in/asha-rao', 'https://evil-linkedin.com/in/asha-rao', 'https://linkedin.com@evil.test/in/asha-rao', 'https://user:pass@linkedin.com/in/asha-rao', 'ftp://linkedin.com/in/asha-rao', 'https://linkedin.com/in/asha-rao/posts/', 'https://linkedin.com/company/acme', '/in/', '/in/a%2Fb', 'https://linkedin.com:8080/in/asha-rao']) {
    assert.equal(canonicalProfileUrl(bad), '', bad);
  }
});

test('extracts name, headline and line-separated evidence solely from each individual card', () => {
  const parsed = parseLinkedInPeopleHtml(page(card({ headline: 'Director at Unrelated Business' }) + card({ name: 'Bimal Shah', slug: 'bimal-shah', summary: 'Past: Analyst at Acme Foods<br>Current: Founder at Example Labs' })), SEARCH_URL);
  assert.equal(parsed.status, 'results');
  assert.equal(parsed.results.length, 2);
  const first = parsed.results[0];
  assert.equal(first.name, 'Asha Rao');
  assert.equal(first.headline, 'Director at Unrelated Business');
  assert.equal(first.designation, 'Director');
  assert.equal(first.title, 'Asha Rao - Director at Unrelated Business');
  assert.equal(first.url, 'https://www.linkedin.com/in/asha-rao');
  assert.equal(first.snippet.includes('Acme'), false);
  assert.equal(first.snippet.includes('Bimal'), false);
  assert.equal(first.snippet.includes('Connect'), false);
  assert.match(parsed.results[1].snippet, /Past: Analyst at Acme Foods\nCurrent: Founder at Example Labs/);
});

test('does not invent a director title, profile name, or company evidence from the query', () => {
  const parsed = parseLinkedInPeopleHtml(page(card({ headline: 'Engineer at Example Labs' }) + card({ name: 'LinkedIn Member', slug: 'hidden-person' }) + card({ name: 'Private Profile', slug: 'private-profile' }) + card({ name: 'Bad Person', url: 'https://linkedin.com.evil.test/in/bad-person' })), SEARCH_URL);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].designation, '');
  assert.equal(parsed.results[0].snippet.includes('Director'), false);
  assert.equal(parsed.results[0].snippet.includes('Acme'), false);
  assert.deepEqual(parseLinkedInPeopleHtml(page(card({ name: 'LinkedIn Member' })), SEARCH_URL), { status: 'results', results: [] });
});

test('current workspace cards use visible names and keep employer evidence inside each text block', () => {
  const parsed = parseLinkedInPeopleHtml(workspacePage(
    workspaceCard({ headline: 'GM Marketing ,ARL Tyres Limited' }) +
    workspaceCard({ name: 'Bimal Shah', slug: 'bimal-shah', headline: 'Director at Example Labs' }),
    `<div role="listitem"><p><a href="/in/other-account/">Other Account</a></p><div><p>CEO at Acme Foods</p></div></div>`
  ), SEARCH_URL);
  assert.equal(parsed.status, 'results');
  assert.equal(parsed.results.length, 2);
  assert.deepEqual(parsed.results.map(({ name, headline, url }) => ({ name, headline, url })), [
    { name: 'Asha Rao', headline: 'GM Marketing ,ARL Tyres Limited', url: 'https://www.linkedin.com/in/asha-rao' },
    { name: 'Bimal Shah', headline: 'Director at Example Labs', url: 'https://www.linkedin.com/in/bimal-shah' },
  ]);
  assert.equal(parsed.results[0].designation, '');
  assert.equal(parsed.results[1].designation, 'Director');
  assert.match(parsed.results[0].snippet, /GM Marketing ,ARL Tyres Limited\nHyderabad, Telangana, India/);
  for (const result of parsed.results) assert.doesNotMatch(result.snippet, /Acme|Signed In|Other Account|Connect/);
  assert.doesNotMatch(parsed.results[0].snippet, /Bimal|Example Labs/);
  assert.doesNotMatch(parsed.results[1].snippet, /Asha|ARL Tyres/);
});

test('workspace results reject a different name-link account and mixed-person evidence', () => {
  const changedNameTarget = workspaceCard({ nameSlug: 'different-person' });
  const mixedEvidence = workspaceCard({ extra: '<p><a href="/in/different-person/">Different Person</a> CEO at Acme Foods</p>' });
  for (const cards of [changedNameTarget, mixedEvidence]) {
    assert.deepEqual(parseLinkedInPeopleHtml(workspacePage(cards), SEARCH_URL), { status: 'unexpected', results: [] });
  }
});

test('empty name links in both layouts remain loading instead of finishing with zero people', () => {
  const legacyShell = '<li class="search-result__occluded-item"><div class="entity-result__title-text"><a href="/in/asha-rao"></a></div></li>';
  assert.equal(parseLinkedInPeopleHtml(page(legacyShell), SEARCH_URL).status, 'unexpected');
  assert.equal(parseLinkedInPeopleHtml(workspacePage(workspaceCard({ name: '', headline: '' })), SEARCH_URL).status, 'unexpected');
});

test('empty results, loading shells, login, challenge and account limits stay distinct', () => {
  assert.equal(parseLinkedInPeopleHtml(empty, SEARCH_URL).status, 'empty');
  assert.equal(parseLinkedInPeopleHtml(page('<li class="search-result__occluded-item"><div class="loading"></div></li>'), SEARCH_URL).status, 'unexpected');
  assert.equal(parseLinkedInPeopleHtml('<p>Something changed</p>', SEARCH_URL).status, 'unexpected');
  assert.equal(parseLinkedInPeopleHtml('<input name="session_key">', SEARCH_URL).status, 'not_connected');
  assert.equal(parseLinkedInPeopleHtml(page(), 'https://www.linkedin.com/authwall').status, 'not_connected');
  assert.equal(parseLinkedInPeopleHtml(page(), 'https://www.linkedin.com/checkpoint/challenge/abc').status, 'verification_required');
  assert.equal(parseLinkedInPeopleHtml('<p>Security verification</p>', SEARCH_URL).status, 'verification_required');
  assert.equal(parseLinkedInPeopleHtml(page(), SEARCH_URL, 429).status, 'rate_limited');
  assert.equal(parseLinkedInPeopleHtml('<p>You’ve reached your commercial use limit</p>', SEARCH_URL).status, 'rate_limited');
  assert.equal(parseLinkedInPeopleHtml(page(), SEARCH_URL, 503).status, 'unavailable');
  assert.equal(parseLinkedInPeopleHtml(page(), 'https://example.com/search/results/people/').status, 'unexpected');
});

test('query variants retain descriptive company words and require a company', () => {
  assert.deepEqual(buildLinkedInQueries({ personName: 'Asha Kumari Rao', companyName: 'Acme Foods Private Limited RXIL' }), ['Asha Kumari Rao acme foods', 'Asha Rao acme foods']);
  assert.deepEqual(buildLinkedInQueries({ personName: 'Asha Rao', companyName: 'Acme Technologies Ltd' }), ['Asha Rao acme technologies']);
  assert.deepEqual(buildLinkedInQueries({ companyName: 'Acme Foods Pvt Ltd' }), ['acme foods director', 'acme foods founder', 'acme foods CEO']);
  assert.deepEqual(buildLinkedInQueries({ personName: 'Asha Rao' }), []);
});

function fakeBrowser({ html = page(), cookies = [{ name: 'li_at', domain: '.linkedin.com', expires: -1, value: 'never-return-this-secret' }], onGoto, hasProfile = true } = {}) {
  const launches = [];
  const navigations = [];
  const waits = [];
  const contexts = [];
  let tick = 0;
  const chromium = { launchPersistentContext: async (directory, options) => {
    assert.equal(contexts.filter((ctx) => !ctx.closed).length, 0, 'only one profile owner');
    launches.push({ directory, options });
    const context = new EventEmitter();
    context.closed = false;
    context.allPages = [];
    context.cookies = async () => cookies;
    context.pages = () => context.allPages.filter((tab) => !tab.closed);
    context.newPage = async () => {
      const tab = { closed: false, currentUrl: 'about:blank', html,
        url: () => tab.currentUrl, isClosed: () => tab.closed,
        goto: async (url) => {
          tab.currentUrl = url;
          navigations.push(url);
          if (onGoto) await onGoto(tab, url);
          return { status: () => tab.httpStatus || 200 };
        },
        content: async () => typeof tab.html === 'function' ? tab.html(tab.currentUrl) : tab.html,
        evaluate: async () => {}, bringToFront: async () => {},
        close: async () => { tab.closed = true; },
      };
      context.allPages.push(tab);
      return tab;
    };
    context.close = async () => { context.closed = true; for (const tab of context.allPages) await tab.close(); context.emit('close'); };
    contexts.push(context);
    return context;
  } };
  const client = createLinkedInDirectClient({ chromium, profileDir: '.linkedin-profile-test', hasProfile: () => hasProfile,
    now: () => tick, pause: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      waits.push(ms); tick += ms;
    } });
  return { client, launches, navigations, contexts, waits, cookies, advance: (ms) => { tick += ms; } };
}

test('unconfigured scans/status do not open a browser or make network requests', async () => {
  const fake = fakeBrowser({ hasProfile: false, cookies: [] });
  assert.equal((await fake.client.getLinkedInStatus()).connected, false);
  await assert.rejects(fake.client.searchLinkedInDirect({ companyName: 'Acme' }), (error) => error.code === 'SEARCH_UNAVAILABLE' && error.directSearch && /Connect LinkedIn/.test(error.message));
  assert.equal(fake.launches.length, 0);
});

test('direct scans use only LinkedIn people pages, reuse one session, pace, and preserve rejected evidence', async () => {
  const fake = fakeBrowser({ html: (url) => {
    const query = new URL(url).searchParams.get('keywords');
    return page(card({ headline: query.includes('Kumari') ? 'Director at Unrelated Business' : 'Director at Acme Foods' }));
  } });
  const results = await fake.client.searchLinkedInDirect({ personName: 'Asha Kumari Rao', companyName: 'Acme Foods Ltd', accept: (candidate) => candidate.headline.includes('Acme') });
  assert.equal(fake.navigations.length, 2);
  for (const raw of fake.navigations) {
    const url = new URL(raw);
    assert.equal(url.origin, 'https://www.linkedin.com');
    assert.equal(url.pathname, '/search/results/people/');
  }
  assert.equal(fake.launches[0].options.headless, true);
  assert.equal(fake.contexts[0].closed, false);
  assert.equal(results[0].snippet.includes('Unrelated'), true, 'unaccepted results retain their original evidence');
  assert.ok(fake.waits.some((ms) => ms >= 1900));
  await fake.client.searchLinkedInDirect({ companyName: 'Acme Foods' });
  assert.equal(fake.launches.length, 1);
  const status = await fake.client.getLinkedInStatus();
  assert.equal(status.connected, true);
  assert.equal(JSON.stringify(status).includes('never-return-this-secret'), false);
  await fake.client.closeLinkedInBrowser();
  assert.equal(fake.contexts[0].closed, true);
});

test('browser queue serializes concurrent scans and switching to an explicit headed connection', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  const fake = fakeBrowser({ onGoto: async () => { if (++calls === 1) { entered(); await held; } } });
  const scan = fake.client.searchLinkedInDirect({ companyName: 'Acme' });
  await started;
  const secondScan = fake.client.searchLinkedInDirect({ personName: 'Asha Rao', companyName: 'Acme' });
  const connect = fake.client.connectLinkedIn();
  await Promise.resolve();
  assert.equal(fake.navigations.length, 1);
  release();
  await Promise.all([scan, secondScan, connect]);
  assert.equal(fake.launches.length, 2);
  assert.equal(fake.contexts[0].closed, true);
  assert.equal(fake.launches[1].options.headless, false);
  assert.equal(fake.navigations.at(-1), 'https://www.linkedin.com/login');
  await fake.client.searchLinkedInDirect({ companyName: 'Acme' });
  assert.equal(fake.launches.length, 2, 'scans reuse the existing headed sign-in context');
  await fake.client.closeLinkedInBrowser();
});

test('a checkpoint stays disconnected despite an auth cookie until the sign-in tab leaves verification', async () => {
  const fake = fakeBrowser({ onGoto: async (tab, url) => { tab.currentUrl = 'https://www.linkedin.com/checkpoint/challenge/123'; } });
  await assert.rejects(fake.client.searchLinkedInDirect({ companyName: 'Acme' }), (error) => error.code === 'SEARCH_UNAVAILABLE' && error.status === 'verification_required');
  let status = await fake.client.getLinkedInStatus();
  assert.equal(status.connected, false);
  assert.equal(status.configured, true);
  assert.equal(status.status, 'verification_required');
  await fake.client.connectLinkedIn();
  assert.equal((await fake.client.getLinkedInStatus()).connected, false);
  fake.contexts.at(-1).pages()[0].currentUrl = 'https://www.linkedin.com/feed/';
  assert.equal((await fake.client.getLinkedInStatus()).connected, true);
  await fake.client.closeLinkedInBrowser();
});

test('genuine empty searches try the bounded variants; limits and changed layouts are explicit failures', async () => {
  const noResults = fakeBrowser({ html: empty });
  assert.deepEqual(await noResults.client.searchLinkedInDirect({ companyName: 'Acme' }), []);
  assert.equal(noResults.navigations.length, 3);
  await noResults.client.closeLinkedInBrowser();
  for (const [html, status] of [['<body>Too many requests</body>', 'rate_limited'], ['<body>new layout</body>', 'unexpected'], ['<input name="session_key">', 'not_connected']]) {
    const fake = fakeBrowser({ html });
    await assert.rejects(fake.client.searchLinkedInDirect({ companyName: 'Acme' }), (error) => error.directSearch && error.code === 'SEARCH_UNAVAILABLE' && error.status === status);
    assert.equal(fake.navigations.length, 1);
    if (status === 'rate_limited') {
      await assert.rejects(fake.client.searchLinkedInDirect({ companyName: 'Other company' }), /limited searches/);
      assert.equal(fake.navigations.length, 1, 'account cooldown prevents repeat requests');
    }
    await fake.client.closeLinkedInBrowser();
  }
});

test('cancelling a queued scan rejects promptly and never navigates for that scan', async () => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const fake = fakeBrowser({ onGoto: async () => { entered(); await gate; } });
  const first = fake.client.searchLinkedInDirect({ companyName: 'Acme' });
  await started;
  const controller = new AbortController();
  const queued = fake.client.searchLinkedInDirect({ companyName: 'Other', signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  release();
  await first;
  await fake.client.closeLinkedInBrowser();
  assert.equal(fake.navigations.length, 1);
});

test('a profile held by another Chrome is reported as in use, not as a missing browser', async () => {
  const launches = [];
  const chromium = { launchPersistentContext: async (directory, options) => {
    launches.push(options);
    throw new Error('browserType.launchPersistentContext: Target page, context or browser has been closed\nBrowser logs:\n[pid=1][out] Opening in existing browser session.');
  } };
  const client = createLinkedInDirectClient({ chromium, profileDir: '.linkedin-profile-test', hasProfile: () => true });
  await assert.rejects(client.searchLinkedInDirect({ companyName: 'Acme' }),
    (error) => error.code === 'SEARCH_UNAVAILABLE' && /already in use/.test(error.message));
  assert.equal(launches.length, 1, 'never falls back to Chromium on a locked profile');
});
