const https = require('https');
function get(u) {
  return new Promise((res, rej) => {
    https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' } }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}
get('https://www.bing.com/search?q=TCS+official+website&count=20').then((html) => {
  const re = /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"/gi;
  let m, n = 0;
  while ((m = re.exec(html)) && n < 6) { console.log(m[1]); n++; }
  if (n === 0) console.log('NO H2 MATCHES');
});
