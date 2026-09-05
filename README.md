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

The connection check requires actual search results; an empty JSON response is not treated as a working engine. Upstream CAPTCHA and timeout messages appear in the log. Empty searches are retried on later runs, and successful cached results expire after ten minutes.

The legacy `GET /api/serper-check` endpoint only reports configuration; it no longer makes a paid request. Use the **Test connection** button (`POST /api/search-check`) to test the selected provider explicitly.

When ZaubaCorp is used, a matching SearXNG result opens the company page at `#director-information` (the **Directors** section). The agent expands collapsed director panels, waits for rows to load, and extracts all current directors from that section. Past appointments and unrelated tables are excluded. Older layouts are used only when the section is absent.

If the company page cannot be loaded or has no Directors section, the agent can recover explicitly named directors from indexed ZaubaCorp company summaries and current director associations. These rows are marked **ZaubaCorp (search result)** and link to the indexed source. A present empty Directors section is never replaced with indexed names.

The results retain DIN/DPIN numbers and appointment dates, and the ZaubaCorp source link opens the Directors section. These details and the source URL are included in the Excel report. LinkedIn lookups try both registry names and names without middle names; a URL is returned only when the result supports both the person's identity and company, including company information in the snippet. Unverified URLs are shown as `NULL`.

Progress counts completed companies and reaches 100% when the Excel report is ready. Event streaming and fallback polling stop on completion, cancellation, or failure; polling snapshots replace previous rows and logs without duplicating them.

## Cancelling a run

**Cancel Processing** in the *Processing Status* card stops a job in progress (`POST /api/cancel/:jobId`). Cancellation is cooperative: the agent stops at its next clean boundary - after the company it is currently researching, or between LinkedIn lookups within it - so nothing is lost mid-write. The remaining companies are skipped and the wait between companies is cut short.

Rows already collected are kept and still written to Excel: the job ends as `cancelled` with a downloadable partial report whose Summary sheet records `Cancelled by user after N of M companies`. A job that already finished or failed cannot be cancelled, and the button disappears once a job reaches a terminal state.

## Checks

`npm test` runs offline search-provider, ZaubaCorp LinkedIn matching, job completion, cancellation, route, and matching-rule regression checks without spending API credits.

`npm run test:ui` checks provider controls, upload flow, progress, stream replay, polling retries, cancellation with a partial report, and completion in headless Chromium with mocked search responses.
