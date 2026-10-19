// robots.txt (RFC 9309) for the generic sources (rss, json_feed). Official vendor APIs do not need this.

/**
 * @param {string} text
 * @returns {{agents:string[], rules:{allow:boolean, pattern:string}[]}[]}
 */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const line of String(text).slice(0, 500_000).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2];
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (cur) cur.rules.push({ allow: field === 'allow', pattern: value });
    } else lastWasAgent = false;
  }
  return groups;
}

function patternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/**
 * @param {ReturnType<typeof parseRobots>} groups
 * @param {string} product product token of our user agent, e.g. "InstashoutFetcher"
 * @param {string} pathAndQuery
 */
export function isAllowed(groups, product, pathAndQuery) {
  const token = product.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.startsWith(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.pattern !== '');
  let best = null;
  for (const r of rules) {
    if (!patternToRegExp(r.pattern).test(pathAndQuery)) continue;
    // longest pattern wins, Allow wins a tie
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}
