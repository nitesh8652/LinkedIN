const https = require('https');
const http = require('http');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function get(u) {
  return new Promise((res) => {
    const mod = u.startsWith('https') ? https : http;
    const req = mod.get(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res({ code: r.statusCode, body: d }));
    });
    req.on('error', (e) => res({ code: 0, body: e.message }));
  });
}

(async () => {
  let r = await get('https://www.bing.com/search?q=TCS+official+website&count=20');
  console.log('bing:', r.code, 'len', r.body.length, '| h2 links:', (r.body.match(/<h2><a href=/g) || []).length);

  r = await get('https://lite.duckduckgo.com/lite/?q=TCS+official+website');
  console.log('ddg-lite:', r.code, 'len', r.body.length);

  r = await get('https://www.mojeek.com/search?q=TCS+official+website');
  const mjkLinks = (r.body.match(/<a class="ob" href="/g) || []).length;
  console.log('mojeek:', r.code, 'len', r.body.length, '| ob links:', mjkLinks);
})();
