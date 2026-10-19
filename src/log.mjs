import { safeMessage } from './util.mjs';

/**
 * Logger that cannot leak: every line passes through the redactor (secrets removed, URLs reduced to their host).
 * @param {{secrets?:string[], write?:(line:string)=>void}} [o]
 */
export function createLogger({ secrets = [], write = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const line = (level, msg) => write(`${level} ${safeMessage(msg, secrets)}`);
  return {
    info: (m) => line('INFO ', m),
    warn: (m) => line('WARN ', m),
    error: (m) => line('ERROR', m),
    /** an error object -> a short safe message */
    fail: (prefix, err) => line('ERROR', `${prefix}: ${safeMessage(err, secrets)}`),
  };
}
