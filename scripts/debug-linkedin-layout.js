// Local diagnostic for the app's dedicated LinkedIn session. Saves only the
// rendered main-page markup; scripts, inputs and credential-bearing attributes
// are excluded. Run while the app's LinkedIn browser is closed.
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const { createLinkedInDirectClient } = require('../src/linkedin-direct');

const client = createLinkedInDirectClient({ chromium: {
  async launchPersistentContext(...args) {
    const context = await chromium.launchPersistentContext(...args);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      const close = page.close.bind(page);
      page.close = async (...closeArgs) => {
        if (!page.isClosed() && new URL(page.url()).pathname.startsWith('/search/')) {
          const $ = cheerio.load(await page.content());
          $('script,style,svg,input,textarea,select,form,noscript,iframe').remove();
          const main = $('main').first();
          const root = main.length ? main : $('body');
          root.find('*').addBack().each((_, element) => {
            for (const key of Object.keys(element.attribs || {})) {
              if (!['class','id','role','data-view-name','data-testid','aria-hidden','aria-label','hidden','href','alt'].includes(key)) $(element).removeAttr(key);
            }
            if (element.attribs?.href) {
              try {
                const url = new URL(element.attribs.href, 'https://www.linkedin.com');
                url.search = ''; url.hash = '';
                $(element).attr('href', url.href);
              } catch { $(element).removeAttr('href'); }
            }
          });
          const output = path.join(__dirname, '..', 'outputs', 'linkedin-live-layout.html');
          fs.writeFileSync(output, $.html(root));
          console.log(JSON.stringify({ diagnostic: output, pagePath: new URL(page.url()).pathname, profileLinks: root.find('a[href*="/in/"]').length }));
        }
        return close(...closeArgs);
      };
      return page;
    };
    return context;
  },
} });

(async () => {
  try {
    const [personName, companyName] = process.argv.slice(2);
    if (!companyName) throw new Error('Usage: node scripts/debug-linkedin-layout.js "Person Name" "Company Name"');
    const status = await client.getLinkedInStatus();
    console.log(JSON.stringify({ connected: status.connected, status: status.status }));
    if (!status.connected) return;
    const results = await client.searchLinkedInDirect({ personName, companyName, log: console.log });
    console.log(JSON.stringify({ results: results.length }));
  } catch (error) { console.log(error.message); }
  finally { await client.closeLinkedInBrowser(); }
})();
