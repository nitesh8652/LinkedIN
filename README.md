# Company Research Agent

Install dependencies with `npm install`, install Chromium with `npm run install-browser`, then run `npm start`. Open http://localhost:3000.

## Search providers

Use the **Serper / SearXNG** buttons above the upload area. Your browser remembers the selection and instance URL. Each upload captures its settings, so changing the selection does not change a running job. The job log and Excel summary identify the provider and any scraped-engine fallback.

- **Serper:** set `SERPER_API_KEY` in `.env`. Queries and explicit connection tests use credits. Loading the page does not perform a paid connection test.
- **SearXNG:** enter the URL of a running instance, for example `http://localhost:8080`, and click **Test connection**. This mode never calls Serper, including during connection tests or fallback. SearXNG is a separate service; selecting it does not start a server.

SearXNG must allow JSON responses. Add `json` to the existing `search.formats` list in its `settings.yml` and restart the instance:

```yaml
search:
  formats:
    - html
    - json
```

See the official [SearXNG installation guide](https://docs.searxng.org/admin/installation.html) and [Search API documentation](https://docs.searxng.org/dev/search_api.html). Many public instances disable JSON or apply rate limits. The URL must be reachable from the Node server; `localhost` refers to that machine.

Optional `.env` defaults (merge these into your existing file):

```dotenv
SEARCH_PROVIDER=searxng
SEARXNG_URL=http://localhost:8080
```

Both the base instance URL and its `/search` URL are accepted, including deployments under a path prefix. An unavailable SearXNG instance stops a job at its initial connection check with a setup error. Later search failures use the existing scraped engines and are logged, without switching to Serper.

The legacy `GET /api/serper-check` endpoint only reports configuration; it no longer makes a paid request. Use the **Test connection** button (`POST /api/search-check`) to test the selected provider explicitly.

ZaubaCorp is searched immediately if the official website is missing. If website research finds directors but leaves any LinkedIn URLs missing, the agent also searches ZaubaCorp once for that company. Existing matches are preserved, and matching registry names enrich the same rows without duplicates. If all website directors already have LinkedIn URLs, the registry lookup is skipped.

A matching ZaubaCorp result opens the company page at `#director-information` (the **Directors** section). The agent expands collapsed director panels, waits for rows to load, and extracts all current directors from that section. Past appointments and unrelated tables are excluded. Older layouts are used only when the section is absent.

Each registry name is searched together with the company, starting with a plain query such as `Plasmagen Biosciences Arnav Jain`. In SearXNG mode, these profile lookups explicitly select its Google engine, then use LinkedIn-specific query variants if necessary. The Google engine must be enabled on the instance. These lookups never switch to Serper or direct scrapers if Google is unavailable. Upstream errors such as `google: Suspended: CAPTCHA` are shown in the job log.

The results retain DIN/DPIN numbers and appointment dates, and the ZaubaCorp source link opens the Directors section. These details and the source URL are included in the Excel report. LinkedIn lookups try both registry names and names without middle names; a URL is returned from the search results only when the result supports both the person's identity and company, including company information in the snippet. Unverified URLs are shown as `NULL`.

Progress counts completed companies and reaches 100% when the Excel report is ready. Event streaming and fallback polling stop on completion or failure; polling snapshots replace previous rows and logs without duplicating them.

## Checks

`npm test` runs offline search-provider, ZaubaCorp LinkedIn matching, job completion, route, and matching-rule regression checks without spending API credits.

`npm run test:ui` checks provider controls, upload flow, progress, stream replay, polling retries, and completion in headless Chromium with mocked search responses.
