// The ingest endpoint takes at most 200 jobs and ~1 MB per request. Split by count AND by bytes.

export const MAX_JOBS_PER_BATCH = 200;
export const MAX_BATCH_BYTES = 900_000; // the endpoint's limit is 1 MB; this leaves room for the envelope

/** Bytes of one job as it will appear in the request body. */
export const jobBytes = (job) => Buffer.byteLength(JSON.stringify(job), 'utf8');

export class JobBatcher {
  /**
   * @param {{maxCount?:number, maxBytes?:number, envelopeBytes?:number}} [o]
   */
  constructor({ maxCount = MAX_JOBS_PER_BATCH, maxBytes = MAX_BATCH_BYTES, envelopeBytes = 400 } = {}) {
    this.maxCount = maxCount;
    this.maxBytes = maxBytes;
    this.envelope = envelopeBytes;
    this.jobs = [];
    this.bytes = envelopeBytes;
  }

  /**
   * Add a job. Returns the batches that are now full (0 or 1), or `{oversize:true}` when a single job can never fit.
   * @returns {{ready: object[][], oversize?: boolean}}
   */
  add(job) {
    const size = jobBytes(job) + 1; // + the comma
    if (size + this.envelope > this.maxBytes) return { ready: [], oversize: true };
    const ready = [];
    if (this.jobs.length >= this.maxCount || this.bytes + size > this.maxBytes) ready.push(this.take());
    this.jobs.push(job);
    this.bytes += size;
    return { ready };
  }

  /** Whatever is left (call at the end). */
  flush() {
    return this.jobs.length ? [this.take()] : [];
  }

  take() {
    const out = this.jobs;
    this.jobs = [];
    this.bytes = this.envelope;
    return out;
  }
}
