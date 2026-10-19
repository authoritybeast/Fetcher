#!/usr/bin/env node
// Instashout fetcher: asks the backend which sources are due, fetches each one, posts the jobs. See README.md.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHttp, userAgentFor } from './http.mjs';
import { createIngest } from './ingest.mjs';
import { createLogger } from './log.mjs';
import { runSource } from './run.mjs';

const RUN_BUDGET_MS = 26 * 60 * 1000; // the workflow times out at 30 minutes: stop starting new work before that

/** Minimal .env reader for local runs (the file is git-ignored). Values already in the environment win. */
function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/**
 * @param {string[]} [argv]
 * @param {Record<string,string|undefined>} [env]
 * @param {{createApi?: typeof createIngest, createClient?: typeof createHttp, log?: ReturnType<typeof createLogger>}} [deps] injected by the tests
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const dryRun = argv.includes('--dry-run') || /^(1|true|yes)$/i.test(env.DRY_RUN || '');
  const onlyIdx = argv.indexOf('--source');
  const only = (onlyIdx >= 0 ? argv[onlyIdx + 1] : env.SOURCE_NAME || '').trim();
  const secrets = [env.INGEST_TOKEN, env.INGEST_URL, env.USAJOBS_API_KEY, env.USAJOBS_EMAIL].filter(Boolean);
  const log = deps.log || createLogger({ secrets });

  let api;
  try {
    api = (deps.createApi || createIngest)({ url: env.INGEST_URL || '', token: env.INGEST_TOKEN || '' });
  } catch (e) {
    log.fail('configuration', e);
    return 1;
  }

  const deadline = Date.now() + RUN_BUDGET_MS;
  const expired = () => Date.now() > deadline;
  let due;
  try {
    due = await api.due();
  } catch (e) {
    log.fail('could not ask which sources are due', e);
    return 1;
  }
  const todo = only ? due.filter((s) => s.name === only) : due;
  log.info(`${due.length} source(s) due${only ? `, running "${only}": ${todo.length} match` : ''}${dryRun ? ' (dry run: nothing is sent)' : ''}`);

  const results = [];
  for (const source of todo) {
    if (expired()) {
      log.warn(`${source.name}: skipped, the run time budget is used up (it will be due again next hour)`);
      continue;
    }
    // A fresh client per source: its own politeness clock and robots cache.
    const http = (deps.createClient || createHttp)({ expired, userAgent: userAgentFor(env.GITHUB_REPOSITORY) });
    try {
      results.push(await runSource({ source, api, env, http, log, dryRun, expired, secrets }));
    } catch (e) {
      log.fail(`${source.name}: unexpected error`, e); // one broken source never stops the others
    }
  }
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'not_started').length;
  log.info(`done: ${results.length} run(s), ${failed} failed`);
  return 0; // per-source failures are recorded in the admin panel; only setup problems fail the workflow
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnv();
  main().then((code) => process.exit(code));
}
