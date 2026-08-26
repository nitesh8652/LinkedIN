const { parseBingResults } = require('../src/search');
const https = require('https');

https.get('https://www.bing.com/search?q=TCS+official+website&count=20', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
}, (r) => {
  let d = '';
  r.on('data', (c) => (d += c));
  r.on('end', () => {
    const res = parseBingResults(d);
    console.log('parsed:', res.length);
    res.slice(0, 5).forEach((x) => console.log(x.url, '|', x.title.slice(0, 50)));
  });
});
