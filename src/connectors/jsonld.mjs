// schema.org JobPosting crawler: not built yet. Selecting this kind fails with a clear message; nothing is fetched.
import { NotImplementedError } from './_common.mjs';

// eslint-disable-next-line require-yield
export async function* fetchJobs() {
  throw new NotImplementedError('the jsonld connector is not implemented yet');
}
