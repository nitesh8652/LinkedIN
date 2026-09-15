# Company Research Agent

Install dependencies with `npm install`, install Chromium with `npm run install-browser`, then run `npm start`. Open http://localhost:3000.

## Search providers

Use the **LinkedIn Direct / Own Search / Serper / SerpApi / SearXNG / SerpApi + SearXNG** buttons above the upload area. Your browser remembers the selection and instance URL. Each upload captures its settings, so changing the selection does not change a running job. The job log and Excel summary identify the provider and any scraped-engine fallback.

### LinkedIn Direct (no search API credits)

Select **LinkedIn Direct**, click **Connect LinkedIn**, and sign in in the browser window that opens. Return to the app and click **Test connection**, then upload the workbook. New browser sessions default to Direct; if the app remembers Own Search or SerpApi, select LinkedIn Direct once.

Use columns **Company Name**, **Director Name**, and optionally **Designation**. Repeat the company on separate rows for multiple directors. The app searches LinkedIn people results using each director's name plus the company, trying a shorter name when needed. A returned profile must identify both the person and the company. Blank or `NULL` director names use company-only discovery, so an earlier report can be uploaded again.

Company-only uploads search LinkedIn directly for the company and director/leadership roles. Names, roles, and company evidence must come from the same profile card; former roles are excluded. These are LinkedIn-stated roles, not a verified list of statutory directors. This mode does not depend on ZaubaCorp, SearXNG, DuckDuckGo, Brave, Bing, Serper, SerpApi, or an LLM. It keeps unsuccessful supplied names in the report with a reason.

The dedicated login session is stored locally in `.linkedin-profile/` (excluded from Git). Sign-in, checkpoint, rate-limit, and unexpected-page failures are reported as unavailable rather than as missing people. Complete any required sign-in or verification in the connected browser; the app does not bypass it. Scans are paced and bounded, and cannot guarantee access or complete coverage of LinkedIn results.

**Own Search** (`SEARCH_PROVIDER=own`) uses this app's own search API: SearXNG starts first; direct DuckDuckGo, Brave and Bing searches join if it fails, lacks a usable match, or takes longer than 1.5 seconds. A fast useful SearXNG response avoids duplicate requests to the same search engines. It never calls Serper or SerpApi, even if their keys are configured. It feeds the same website discovery, director research, ZaubaCorp fallback and LinkedIn name/company verification pipeline as the existing hybrid mode. Previously saved browser choices are retained; click **Own Search** to switch.

Start Docker Desktop, run `npm run start:searxng`, then run `npm start`. The setup command starts the existing `searxng` container if present; otherwise it creates one on `http://localhost:8080` with JSON enabled and a generated secret. Existing settings are preserved. Direct searches can still work if SearXNG is offline. Click **Test connection** before an upload. `npm run test:search:live` exercises the real JSON API and both website/registry LinkedIn matching without calling a paid LLM or search API.

Own Search keeps titles, employer snippets and source names, decodes search redirects and merges duplicate profiles. For LinkedIn it waits for a verified name-and-company match instead of accepting the first namesake. Requests have a 15-second deadline, a four-query concurrency cap, per-source pacing and cooldowns after rate limits or CAPTCHA. A partial SearXNG outage suspends only the affected engines; healthy engines stay eligible for later queries and companies. Unrelated results reject that query without disabling the source. Successful results are cached for ten minutes (30 seconds when sources are degraded). Empty searches are retried. Sources that fail are reported as unavailable, including incomplete searches without a usable match. ZaubaCorp keeps a matched company's source URL when an indexed-director search is temporarily unavailable.

This is an organic web-search replacement for this workflow, not a complete copy of either commercial service or a guaranteed Google index. Search sources can rate-limit or change their HTML. It uses public indexed LinkedIn evidence; it does not require a LinkedIn login or bypass login/CAPTCHA pages.

### Your JSON search API

The app exposes these endpoints on the same server, normally `http://localhost:3000`:

| Endpoint | Input | Response |
| --- | --- | --- |
| `POST /api/search` or `POST /search` | JSON or form body: `q`, optional `num` (1–50) | `organic` (Serper style), `organic_results` (SerpApi style), normalized `results`, source/warning/cache metadata |
| `GET /api/search` or `GET /search.json` | Query parameters: `q`, optional `num` | Same response |
| `GET /api/search/health` | None | Last observed source health; does not make searches |

Example in PowerShell:

```powershell
Invoke-RestMethod http://localhost:3000/search -Method Post -ContentType 'application/json' -Body '{"q":"Sethu Madhavan PlasmaGen Biosciences linkedin","num":10}'
```

The compatibility contract covers organic fields (`title`, `link`, `snippet`, `position`). `engine=google` is accepted for clients migrating from SerpApi, but metadata identifies the actual provider as `own` and the returned results may come from several engines. Pagination, country/language overrides, maps, images and knowledge panels are not implemented; unsupported parameters return HTTP 400. `num` is an upper bound, not a promised result count. Search outages return HTTP 503 with `SEARCH_UNAVAILABLE`, not a successful empty response.

The API uses the server's SearXNG configuration. Clients cannot supply a target URL or paid provider. With `OWN_SEARCH_API_KEY` blank it accepts loopback clients only. When set, every API request requires that key using `X-API-KEY`, `Authorization: Bearer ...`, or the SerpApi-compatible `api_key` query parameter. Prefer headers so the key does not appear in URL logs. This key protects the standalone search endpoints; the existing research UI remains a local application, so do not expose the whole app publicly without authentication.

Optional Own Search settings:

```dotenv
SEARCH_PROVIDER=own
SEARXNG_URL=http://localhost:8080
OWN_SEARCH_ENGINES=duckduckgo,brave,bing
OWN_SEARCH_SEARXNG_ENGINES=google,bing,duckduckgo,brave
OWN_SEARCH_TIMEOUT_MS=15000
OWN_SEARCH_FALLBACK_DELAY_MS=1500
OWN_SEARCH_API_KEY=
```

An empty `OWN_SEARCH_ENGINES` uses only SearXNG. Direct Google HTML is also supported via `google`, but often requires a browser check, so it is omitted from direct defaults. SearXNG's Google engine remains enabled in Own Search. See the [SearXNG Search API](https://docs.searxng.org/dev/search_api.html) and [SerpApi organic results contract](https://serpapi.com/organic-results) for the upstream formats.

**SerpApi + SearXNG** (`SEARCH_PROVIDER=hybrid`) starts both searches in parallel and uses the first relevant results. For LinkedIn verification it waits for a name-and-company match, so a fast empty response or namesake at another company cannot suppress a slower correct match. Outstanding requests are cancelled once useful results arrive. SerpApi searches can still consume credits when cancelled. If one provider fails, the working provider continues; only failure of both produces an unavailable search. Enter the SearXNG URL and use **Test connection**. If the local Docker service is stopped, start Docker Desktop and the existing `searxng` container.

- **Serper:** set `SERPER_API_KEY` in `.env`. Queries and explicit connection tests use credits. Loading the page does not perform a paid connection test.
- **SerpApi:** set `SERPAPI_API_KEY` in `.env`, restart the server, select **SerpApi**, and click **Test connection**. Uses the [SerpApi Google Search API](https://serpapi.com/search-api) for website discovery, director searches, LinkedIn profile matching, and the ZaubaCorp fallback. Registry pages are read directly when accessible; indexed ZaubaCorp snippets remain available when a page cannot be loaded. Returned LinkedIn profiles must match the person's name and company. The same result table and Excel report include the matches and registry source details. Searches and explicit tests use SerpApi credits; loading the page does not. Failures are reported without switching to another provider. Keys stay on the server and are never sent to the browser. Optional defaults: `SEARCH_PROVIDER=serpapi`, `SERPAPI_GL=in`, `SERPAPI_HL=en`.
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
SEARXNG_ENGINES=google,bing
```

Both the base instance URL and its `/search` URL are accepted, including deployments under a path prefix. An unavailable SearXNG instance stops a job at its initial connection check with a setup error. Later search failures use the existing scraped engines and are logged, without switching to Serper.

The connection check requires actual search results; an empty JSON response is not treated as a working engine. Only the configured web engines run, so unrelated Wikipedia failures do not affect company lookups. Engine warnings appear in the connection check and job log when results may be incomplete. Empty searches are retried on later runs, and successful cached results expire after ten minutes.

When an upstream engine reports CAPTCHA or a timeout, the app temporarily skips it and tries the remaining engines. It logs the suspension once per job. If the remaining searches cannot produce a match, rows retain their known names and show **Search temporarily unavailable** instead of **No LinkedIn match**. Google CAPTCHA is an upstream restriction: the app does not clear SearXNG's suspension state. Retry after recovery or select another working SearXNG instance. `SEARXNG_ENGINES` can list other general web engines supported by that instance.

The legacy `GET /api/serper-check` endpoint only reports configuration; it no longer makes a paid request. Use the **Test connection** button (`POST /api/search-check`) to test the selected provider explicitly.

When ZaubaCorp is used, a matching SearXNG result opens the company page at `#director-information` (the **Directors** section). The agent expands collapsed director panels, waits for rows to load, and extracts all current directors from that section. Past appointments and unrelated tables are excluded. Older layouts are used only when the section is absent.

If the company page cannot be loaded or has no Directors section, the agent can recover explicitly named directors from indexed ZaubaCorp company summaries and current director associations. These rows are marked **ZaubaCorp (search result)** and link to the indexed source. A present empty Directors section is never replaced with indexed names.

The results retain DIN/DPIN numbers and appointment dates, and the ZaubaCorp source link opens the Directors section. These details and the source URL are included in the Excel report. LinkedIn lookups try both registry names and names without middle names; a URL is returned only when the result supports both the person's identity and company, including company information in the snippet. Unverified URLs are shown as `NULL`.

Website and registry names both start with a plain **director name + original company name** query before narrower LinkedIn searches. For example: `VINAY RATHI MODI GLOSTER CABLES LIMITED RXIL`. A trailing `RXIL` list label is removed for company discovery/matching; the original input remains in the report. After a company is matched on ZaubaCorp, its registered name is also used to find and verify profiles. Every current director in its Directors tables is retained, with no eight-person limit on registry results. A longer LinkedIn name such as **Sethu Madhavan Sankaran** can match the website's **Sethu Madhavan** when the profile also identifies PlasmaGen Biosciences.

When official-website search fails, the agent still tries ZaubaCorp, including its own company search if the search engines are unavailable. Search failures retain any known director names; the status cell shows the reason and the Excel report includes a **Search Details** column.

Progress counts completed companies and reaches 100% when the Excel report is ready. Event streaming and fallback polling stop on completion, cancellation, or failure; polling snapshots replace previous rows and logs without duplicating them.

## Cancelling a run

**Cancel Processing** in the *Processing Status* card stops a job in progress (`POST /api/cancel/:jobId`). Cancellation is cooperative: the agent stops at its next clean boundary - after the company it is currently researching, or between LinkedIn lookups within it - so nothing is lost mid-write. The remaining companies are skipped and the wait between companies is cut short.

Rows already collected are kept and still written to Excel: the job ends as `cancelled` with a downloadable partial report whose Summary sheet records `Cancelled by user after N of M companies`. A job that already finished or failed cannot be cancelled, and the button disappears once a job reaches a terminal state.

## Checks

`npm test` runs offline search-provider, ZaubaCorp LinkedIn matching, job completion, cancellation, route, and matching-rule regression checks without spending API credits.

`npm run test:ui` checks provider controls, upload flow, progress, stream replay, polling retries, cancellation with a partial report, and completion in headless Chromium with mocked search responses.
