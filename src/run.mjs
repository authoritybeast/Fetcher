// Runs ONE source: start -> fetch + normalise + send in batches -> finish.
// This file decides the `complete` flag, which makes the database close every job of the source that is not in the run. Rules:
//   complete = connector says complete  AND  no cap/time cut-off  AND  no error  AND  nothing was dropped or rejected
//              AND  every batch was delivered  AND  at least one job was fetched.
// Anything else is complete:false.
import { connectors } from './connectors/index.mjs';
import { ConfigError } from './connectors/_common.mjs';
import { DeadlineError, RateLimitError } from './http.mjs';
import { JobBatcher } from './batching.mjs';
import { finalizeJob } from './job.mjs';
import { safeMessage } from './util.mjs';

/**
 * @typedef {object} RunDeps
 * @property {import('./job.mjs').Source} source
 * @property {ReturnType<import('./ingest.mjs').createIngest>} api
 * @property {Record<string,string|undefined>} env
 * @property {ReturnType<import('./http.mjs').createHttp>} http
 * @property {ReturnType<import('./log.mjs').createLogger>} log
 * @property {boolean} [dryRun]
 * @property {()=>boolean} [expired]
 * @property {string[]} [secrets]
 * @property {Partial<ConstructorParameters<typeof JobBatcher>[0]>} [batching]
 */

/** @param {RunDeps} deps */
export async function runSource({ source, api, env, http, log, dryRun = false, expired = () => false, secrets = [], batching = {} }) {
  const name = source.name;
  const trigger = source.requested ? 'manual' : 'schedule';
  const connector = /** @type {Record<string, any>} */ (connectors)[source.kind];
  const stats = { fetched: 0, dropped: 0, duplicates: 0, sent: 0, new: 0, updated: 0, skipped: 0, db_errors: 0, batches: 0 };
  const started = Date.now();

  let runId = null;
  if (!dryRun) {
    try {
      runId = await api.start(source.id, trigger);
    } catch (e) {
      log.fail(`${name}: could not start a run`, e);
      return { name, status: 'not_started', stats };
    }
  }

  let error = null;
  let rateLimited = false;
  let connectorComplete = false;
  let truncated = false;
  let oversize = false;
  let delivered = true;
  const seen = new Set();
  const batcher = new JobBatcher(batching);

  let ingestFailed = false;
  async function deliver(jobs) {
    try {
      await send(jobs);
    } catch (e) {
      ingestFailed = true;
      delivered = false;
      throw e;
    }
  }

  async function send(jobs) {
    if (dryRun) {
      stats.sent += jobs.length;
      return;
    }
    stats.batches += 1;
    const out = await api.batch(source.id, runId, jobs);
    stats.sent += jobs.length;
    stats.new += Number(out?.new) || 0;
    stats.updated += Number(out?.updated) || 0;
    stats.duplicates += Number(out?.duplicates) || 0;
    stats.skipped += Number(out?.skipped) || 0;
    stats.db_errors += Array.isArray(out?.errors) ? out.errors.length : 0;
  }

  try {
    if (!connector) throw new ConfigError(`unsupported source kind "${String(source.kind).slice(0, 40)}"`);
    const ctx = { source: { ...source, config: source.config && typeof source.config === 'object' ? source.config : {} }, env, http, log, expired };
    const gen = connector.fetchJobs(ctx);
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        connectorComplete = step.value?.complete === true;
        truncated = step.value?.truncated === true;
        break;
      }
      stats.fetched += 1;
      const fin = finalizeJob(step.value ?? {}, source);
      if (!fin.ok) {
        stats.dropped += 1;
        continue;
      }
      if (seen.has(fin.job.external_id)) {
        stats.duplicates += 1; // same id twice in one run: keep the first
        continue;
      }
      seen.add(fin.job.external_id);
      const { ready, oversize: tooBig } = batcher.add(fin.job);
      if (tooBig) {
        oversize = true;
        stats.dropped += 1;
        continue;
      }
      for (const b of ready) await deliver(b);
    }
    for (const b of batcher.flush()) await deliver(b);
  } catch (e) {
    error = e;
    if (e instanceof RateLimitError) rateLimited = true;
    // What was already fetched is valid: send it (unless the ingest endpoint itself is what failed).
    if (!ingestFailed) {
      try {
        for (const b of batcher.flush()) await deliver(b);
      } catch {
        /* recorded by deliver() */
      }
    }
    delivered = delivered && batcher.jobs.length === 0;
  }

  const complete = !dryRun && connectorComplete && !truncated && !error && !oversize && delivered && stats.dropped === 0 && stats.db_errors === 0 && stats.fetched > 0;

  /** @type {'ok'|'partial'|'failed'} */
  let status;
  if (error) {
    status = rateLimited || stats.sent > 0 ? 'partial' : 'failed';
    if (error instanceof DeadlineError) status = 'partial';
  } else status = truncated || !delivered ? 'partial' : 'ok';

  const message = error ? safeMessage(error, secrets) : undefined;
  const details = { ...stats, complete_run: complete, truncated, seconds: Math.round((Date.now() - started) / 1000) };
  log.info(`${name} [${source.kind}]: ${status}${dryRun ? ' (dry run)' : ''} fetched=${stats.fetched} sent=${stats.sent} new=${stats.new} updated=${stats.updated} dropped=${stats.dropped} complete=${complete}${message ? ` error="${message}"` : ''}`);

  if (!dryRun && runId) {
    try {
      await api.finish(runId, { status, complete, ...(message ? { error: message } : {}), details });
    } catch (e) {
      log.fail(`${name}: could not send finish`, e);
    }
  }
  return { name, status, complete, stats, error: message };
}
