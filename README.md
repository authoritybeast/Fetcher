# Fetcher

A small Node 20 program that runs on GitHub Actions every hour. It asks the Instashout backend which job sources are due, downloads the jobs of each source (ATS APIs, public job APIs, RSS, JSON feeds), turns them into one shape and posts them in batches to the Instashout ingest endpoint.

The fetcher is **only a collector**. Validation, HTML sanitising, de-duplication, caps and closing of removed jobs all happen in the database.

- **No applicant data.** The fetcher never reads, stores, logs or sends any applicant or job-seeker data. It has none: it only reads public job listings.
- **Public repository, no secrets in it.** Nothing private is committed, logged or used in a test fixture. The ingest URL and token and the vendor keys come from GitHub Actions secrets.
- MIT licensed. Dependencies: `fast-xml-parser` only. Everything else is Node built-ins (`fetch`, `node:https`, `node:test`).

## How it works

```
GitHub Actions (hourly)                         Instashout backend
        |                                              |
        |-- {"action":"due"} ------------------------->|  which sources are due?
        |<-- [{id, name, kind, config, tier, ...}] ----|
        |
   for each source, one after another:
        |-- start  {source_id, trigger} -------------->|  -> run id
        |   connector downloads + normalises jobs
        |-- batch  {run_id, jobs:[<=200, <~900 KB]} -->|  (repeated)
        |-- finish {status, complete, error, details} >|
```

1. `due` returns the sources whose time has come (`kind`, admin-set `config`, `tier`, `us_only`, `requested`).
2. For each source the fetcher calls `start` (trigger `manual` if the admin pressed "Run now", else `schedule`).
3. The connector for that `kind` yields raw jobs. `src/job.mjs` validates and normalises each one and drops what must not be sent. Jobs are posted in batches of at most 200 and at most ~900 KB (split by count **and** by bytes).
4. `finish` closes the run with `status` (`ok` / `partial` / `failed`) and the `complete` flag.

A broken source never stops the others: every source runs inside its own try/catch and always gets a `finish`. The process exits with code 0 even when some sources failed (those are visible in the admin panel); it exits 1 only for setup problems (missing secrets, the `due` call failing).

### The `complete` flag (important)

`complete: true` makes the database **close every job of that source that was not in this run**. The fetcher sends it only when all of this is true:

- the connector fetched the whole listing (no page cap, job cap, time budget, error or rate limit stopped it),
- every job was understood (nothing had to be dropped) and the database rejected nothing,
- every batch was delivered,
- at least one job was fetched (an empty answer could be an API glitch).

Anything else is `complete: false`. Feeds (`rss`, `json_feed`) are normally a window of the latest items, so they are never complete unless the admin sets `"complete": true` in the source config for a feed known to list every open job.

`status: "failed"` is used only for real failures (nothing usable fetched). A rate limit by the source is `partial`, never `failed`, because five consecutive failures auto-disable a source.

### Legal model: tiers

Every source has a **tier** set by the admin after reading that source's terms:

| tier | what the fetcher does |
|---|---|
| `blocked` | never fetched (the backend does not return it from `due`) |
| `facts_only` | sends facts only (title, company, location, pay, link). **No description is transmitted at all.** |
| `full` | also sends the source's description HTML (cut to 50,000 characters; the database sanitises it) |

The `description` is dropped in `src/job.mjs` for any tier other than `full`, and the database enforces the same rule.

## Connectors

One file each in `src/connectors/`. Interface:

```js
export async function* fetchJobs({ source, env, http, log, expired }) {
  yield { external_id, title, company, apply_url, /* ... */ };
  return { complete: true, truncated: false }; // complete only if the WHOLE listing was fetched
}
```

| kind | source | config |
|---|---|---|
| `greenhouse` | Job Board API, `content=true` | `board_token`, `company_name?` |
| `lever` | Postings API (`eu: true` for the EU host) | `company`, `eu?`, `company_name?` |
| `ashby` | public job-board posting API with compensation | `board`, `company_name?` |
| `smartrecruiters` | public Posting API, limit/offset paging (+ detail per job for tier `full`) | `company_id`, `company_name?` |
| `recruitee` | public offers API | `company` (subdomain), `company_name?` |
| `usajobs` | USAJOBS Search API (needs `USAJOBS_API_KEY` + `USAJOBS_EMAIL`) | `keyword?`, `location?`, `organization?`, `results_per_page?` |
| `remoteok` | public JSON API (legal notice at index 0 skipped) | - |
| `remotive` | public API; refuses to run more than 4 times a day | `limit?` |
| `arbeitnow` | public job-board API (follows `links.next` on the same host) | - |
| `rss` | RSS 2.0 / Atom | `url`, `company_from?` (`title_prefix` / `author` / `fixed:<name>`), `fixed_company?`, `location_from?`, `default_country?`, `complete?` |
| `json_feed` | any JSON feed, pure data mapping | `url`, `items_path?`, `map`, `fixed?`, `next_url_path?`, `complete?` |
| `jsonld` | stub: throws "not implemented yet" | - |

All connectors also accept `max_pages` (can only **lower** the default of 50) and `max_jobs` (default 5000, at most 20,000). When a cap stops a run early the run is `partial` with `complete: false`.

Notes:

- The connectors take `company_name` from the admin config, then from what the source says, then from the source's own name in the panel.
- Pay is sent only when the source gives a clear structured value (Lever, Ashby, Recruitee, USAJOBS, Remote OK), or - for RSS only - the unambiguous text shape `$20 - $25 per hour`. Greenhouse and Remotive send no pay.
- Country: the database assumes `US` when `loc_country` is missing, so the fetcher sets it whenever it can tell (an explicit country field, or "United States" / "Remote - US" / "City, ST"). If it cannot tell and the source is `us_only`, it sends `ZZ` (the database skips those). It never guesses `US`. For a source that is **not** `us_only` and has jobs of unknown country the field is left out, and the database then assumes `US` - keep `us_only` on for such sources.
- US-state normalisation covers the 50 states and DC. "City, ST" is read as a US place only when `ST` is a US state code; the word "Georgia" alone is treated as the country.

### Adding a connector

1. Create `src/connectors/<kind>.mjs` exporting `fetchJobs` (and a pure `mapJob` so it can be tested).
2. Validate every identifier from `source.config` with `identifier()` (it becomes part of a URL), use `limitsOf(source.config)` for the caps, and fetch only through `http.get` / `http.getJson` (never `fetch` directly).
3. Return `{ complete, truncated }` honestly. Any doubt: `complete: false`.
4. Register it in `src/connectors/index.mjs`, add a small hand-made fixture to `test-support/fixtures/` (no real company data) and tests to `test/connectors.test.mjs`.
5. Add the `kind` to the admin panel on the portal side.

## HTTP safety

The source `config` comes from a database, so it is treated as untrusted (`src/http.mjs`, `src/ssrf.mjs`):

- `https:` only, no credentials in URLs, max 3 redirects.
- The host must resolve to **public** addresses only (private, loopback, link-local, metadata, multicast and reserved ranges are refused, IPv4-mapped IPv6 included). The check runs before the request, again at connect time (DNS rebinding) and after every redirect.
- Custom headers (API keys) are never sent to another host after a redirect.
- 20 s timeout, 10 MB response cap (the stream is aborted), only JSON / XML / text content types.
- Retries: max 2 on 5xx / network errors with exponential backoff and jitter. `Retry-After` and 429 are honoured; if the source keeps limiting, the source is given up with `partial`.
- Sources run one after another; requests inside a source are sequential with a gap of at least 300 ms.
- For generic sources (`rss`, `json_feed`) `robots.txt` is checked first (RFC 9309: no `robots.txt` = allowed, unreachable = not allowed). A disallowed feed is not fetched; the run is recorded as `failed` with the message `disallowed by robots.txt` so the admin can see why. Official vendor APIs are not checked.
- Feeds are untrusted text: the XML parser never expands entities (a DOCTYPE entity bomb stays unexpanded), JSON mapping follows own properties only (`__proto__` / `constructor` are refused), and nothing is ever evaluated (`eval` and `new Function` are banned by the lint script).

## Required secrets

Set these under **Settings -> Secrets and variables -> Actions**. Nothing else is used.

| secret | used for |
|---|---|
| `INGEST_URL` | `https://<project>.supabase.co/functions/v1/ingest` |
| `INGEST_TOKEN` | sent as `x-ingest-token` |
| `USAJOBS_API_KEY` | USAJOBS `Authorization-Key` header |
| `USAJOBS_EMAIL` | USAJOBS `User-Agent` header (the address registered with the key) |

The ingest URL and token are never logged and never appear in errors: every log line and every `finish.error` goes through a redactor that removes secrets and reduces URLs to their host. In the Actions log you only see source names, counts and short errors.

## Run it locally

```sh
npm ci
cp .env.example .env     # fill in the values; .env is git-ignored
npm run dry-run          # fetch + normalise, send nothing (no run is recorded)
node src/index.mjs --source "My Lever Source"   # one source (it must be due or requested)
npm start                # a real run
npm test                 # unit tests (node:test, local fake HTTP server, no real network)
npm run lint
```

In a dry run only the read-only `due` call is made; `start`, `batch` and `finish` are skipped and only counts are printed.

### The workflow

- `.github/workflows/fetch.yml` runs at minute 17 of every hour and can be started by hand (**Actions -> Fetch jobs -> Run workflow**) with an optional `source_name` and a `dry_run` switch. Inputs reach the program only through environment variables. One run at a time (`concurrency`, no cancelling), read-only token, 30-minute timeout; the program stops starting new work after 26 minutes (the rest is due again next hour).
- **Admin "Run now"** does not start anything instantly: it marks the source as requested, and the **next hourly pass** picks it up (`requested: true` -> the run is started with trigger `manual`). The manual `source_name` input can only run sources that `due` returns, i.e. sources that are due or requested.
- `.github/workflows/ci.yml` runs lint and tests on every push and pull request.
- `.github/workflows/keepalive.yml`: GitHub disables scheduled workflows in a **public** repository after 60 days without repository activity. Once a month this workflow runs `gh workflow enable fetch.yml` (and re-enables itself) with the `gh` CLI and the workflow's own token (`permissions: actions: write`); no third-party action. If a disabled workflow ever shows up in the Actions tab, enable it there once.
- All third-party actions (`actions/checkout`, `actions/setup-node`) are pinned to full commit SHAs, with the version in a comment. Dependabot updates npm and the actions weekly.

## Security

See [SECURITY.md](SECURITY.md) for how to report a problem. In short: public repo with no secrets, SSRF-guarded HTTP, redacted logs, least-privilege workflows (`contents: read`; `actions: write` only in the keep-alive job), pinned actions, and no applicant or seeker data anywhere.

## Layout

```
src/index.mjs        entry: due -> run each source -> exit code
src/run.mjs          one source: start, fetch, batch, finish; decides status + complete
src/ingest.mjs       client for the ingest endpoint (retries, no secrets in errors)
src/http.mjs         safe HTTP client (SSRF, redirects, limits, retries, robots)
src/ssrf.mjs         address checks and the connect-time lookup guard
src/robots.mjs       robots.txt parser (RFC 9309)
src/normalize.mjs    pure helpers: states, countries, work mode, job type, URLs, salary, dates
src/job.mjs          final validation of a job; tier and country rules
src/batching.mjs     split by count and bytes
src/connectors/      one file per kind
test/                node:test suites
test-support/        local fake server + hand-made fixtures
```
