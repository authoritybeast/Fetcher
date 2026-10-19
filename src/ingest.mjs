// Client for the Instashout ingest endpoint. The URL and token are secrets: they are never logged and never put in errors.
import { sleep as realSleep } from './util.mjs';

export class IngestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'IngestError';
    this.status = status;
  }
}

/**
 * @param {{url:string, token:string, fetchImpl?:typeof fetch, sleep?:(ms:number)=>Promise<void>, timeoutMs?:number, retries?:number, allowHttp?:boolean}} o
 */
export function createIngest({ url, token, fetchImpl = fetch, sleep = realSleep, timeoutMs = 60_000, retries = 2, allowHttp = false }) {
  if (!url || !token) throw new IngestError('INGEST_URL and INGEST_TOKEN are required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new IngestError('INGEST_URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && !allowHttp) throw new IngestError('INGEST_URL must be an https URL');

  async function call(body) {
    let lastStatus;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ingest-token': token, 'user-agent': 'InstashoutFetcher/1.0' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
        lastStatus = res.status;
        let json = null;
        try {
          json = await res.json();
        } catch {
          /* not JSON */
        }
        if (res.ok && json && json.ok === true) return json.data;
        const retryable = res.status >= 500 || res.status === 429;
        if (!retryable || attempt >= retries) {
          const detail = json && typeof json.error === 'string' ? `: ${json.error.slice(0, 120)}` : '';
          throw new IngestError(`ingest answered HTTP ${res.status}${detail}`, res.status);
        }
      } catch (e) {
        if (e instanceof IngestError) {
          if (e.status && e.status < 500 && e.status !== 429) throw e;
          if (attempt >= retries) throw e;
        } else if (attempt >= retries) {
          throw new IngestError('ingest endpoint could not be reached', lastStatus);
        }
      }
      await sleep(1000 * 2 ** attempt);
    }
  }

  return {
    /** @returns {Promise<import('./job.mjs').Source[]>} */
    due: async () => {
      const data = await call({ action: 'due' });
      return Array.isArray(data) ? data : [];
    },
    /** @returns {Promise<string>} run id */
    start: (sourceId, trigger) => call({ action: 'start', source_id: sourceId, trigger }),
    batch: (sourceId, runId, jobs) => call({ action: 'batch', source_id: sourceId, run_id: runId, jobs }),
    finish: (runId, { status, complete, error, details }) =>
      call({ action: 'finish', run_id: runId, status, complete, ...(error ? { error } : {}), ...(details ? { details } : {}) }),
  };
}
