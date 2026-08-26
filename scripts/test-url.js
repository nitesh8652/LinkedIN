const { normalizeUrl } = (() => {
  // re-create inline for debugging
  function normalizeUrl(href) {
    try {
      const u = new URL(href);
      if (u.hostname.includes('bing.com') && u.searchParams.has('u')) {
        const encodedUrl = u.searchParams.get('u');
        const b64 = encodedUrl.replace(/^a1/, '');
        try {
          return Buffer.from(b64, 'base64').toString('utf-8');
        } catch (e) { console.log('decode err', e.message); }
      }
      if (u.hostname.includes('bing.com')) {
        const m2 = href.match(/[?&]u=a1([A-Za-z0-9+/=]+)/);
        if (m2) {
          try {
            return Buffer.from(m2[1], 'base64').toString('utf-8');
          } catch { }
          return null;
        }
      }
      return u.origin + u.pathname;
    } catch (e) {
      console.log('url err', e.message);
      return null;
    }
  }
  return { normalizeUrl };
})();

const sample = 'https://www.bing.com/ck/a?!&amp;&amp;p=e36ba7&amp;ptn=3&amp;u=a1aHR0cHM6Ly93d3cudGNzLmNvbS8&amp;ntb=1';
console.log(JSON.stringify(normalizeUrl(sample)));
