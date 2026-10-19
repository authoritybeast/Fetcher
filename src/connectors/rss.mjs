// Generic RSS 2.0 / Atom feed. Everything in a feed is untrusted text: it is parsed as data, never evaluated, and entities are
// never expanded by the XML parser (so a DOCTYPE cannot blow up memory); the few basic entities are decoded by us.
// Config: { url, company_from?: "title_prefix"|"author"|"fixed:<name>", fixed_company?, location_from?, default_country?, complete?, max_jobs? }
// robots.txt is checked before fetching. A feed is normally a window of the latest items, so `complete` is false unless the admin
// explicitly sets config.complete = true for a feed known to list every open job.
import { XMLParser } from 'fast-xml-parser';
import { decodeEntities, plainText } from '../util.mjs';
import { cleanUrl, normalizeCountry, parseSalaryText } from '../normalize.mjs';
import { HttpError } from '../http.mjs';
import { ConfigError, configOf, limitsOf, placeFields, result } from './_common.mjs';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  textNodeName: '#text',
  cdataPropName: '__cdata',
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link' || name === 'category',
});

/** Text of a node: plain text is entity-decoded, CDATA is taken as is. */
export function textOf(node) {
  if (node === undefined || node === null) return '';
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'string' || typeof node === 'number') return decodeEntities(String(node)).trim();
  if (typeof node === 'object') {
    if (node.__cdata !== undefined) return (Array.isArray(node.__cdata) ? node.__cdata.join('') : String(node.__cdata)).trim();
    if (node['#text'] !== undefined) return decodeEntities(String(node['#text'])).trim();
  }
  return '';
}

function linkOf(links) {
  const list = Array.isArray(links) ? links : links ? [links] : [];
  for (const l of list) {
    if (typeof l === 'string') return decodeEntities(l.trim());
    if (l && typeof l === 'object') {
      const rel = l['@_rel'];
      if (l['@_href'] && (!rel || rel === 'alternate')) return decodeEntities(String(l['@_href']));
      if (!l['@_href'] && textOf(l)) return textOf(l);
    }
  }
  return '';
}

/**
 * @param {string} xml
 * @returns {Record<string, any>[]} the raw item/entry objects
 */
export function parseFeed(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new HttpError('feed is not valid XML');
  }
  const items = doc?.rss?.channel?.item ?? doc?.['rdf:RDF']?.item ?? doc?.feed?.entry;
  if (!Array.isArray(items)) throw new HttpError('not an RSS or Atom feed');
  return items;
}

function companyFor(config, title, item, source) {
  const how = typeof config.company_from === 'string' ? config.company_from : '';
  const fixed = (typeof config.fixed_company === 'string' && config.fixed_company.trim()) || source.name;
  if (how === 'title_prefix') {
    const m = /^(.{2,100}?):\s+(.+)$/.exec(title);
    if (m) return { company: m[1].trim(), title: m[2].trim() };
    return { company: fixed, title };
  }
  if (how === 'author') {
    const author = textOf(item.author?.name ?? item.author) || textOf(item['dc:creator']);
    return { company: author || fixed, title };
  }
  if (how.startsWith('fixed:') && how.slice(6).trim()) return { company: how.slice(6).trim(), title };
  return { company: fixed, title };
}

export function mapItem(item, source) {
  const config = configOf(source.config);
  const rawTitle = plainText(textOf(item.title));
  const { company, title } = companyFor(config, rawTitle, item, source);
  const link = linkOf(item.link) || textOf(item.guid);
  const description = textOf(item['content:encoded']) || textOf(item.description) || textOf(item.content) || textOf(item.summary);
  const locationKey = typeof config.location_from === 'string' && /^[A-Za-z0-9:_.-]{1,60}$/.test(config.location_from) ? config.location_from : '';
  const location = locationKey ? plainText(textOf(item[locationKey])) : '';
  const country = normalizeCountry(config.default_country);
  const place = placeFields(location, country ? { country } : {});
  if (!place.loc_country && country) place.loc_country = country;
  return {
    external_id: textOf(item.guid) || textOf(item.id) || link,
    title,
    company,
    apply_url: cleanUrl(link),
    source_url: cleanUrl(link),
    ...place,
    description,
    category: textOf(item.category) || undefined,
    posted_at: textOf(item.pubDate) || textOf(item.published) || textOf(item.updated) || textOf(item['dc:date']),
    ...parseSalaryText(`${rawTitle} ${plainText(description)}`), // only the unambiguous "$20 - $25 per hour" shape
  };
}

export async function* fetchJobs({ source, http }) {
  const config = configOf(source.config);
  if (typeof config.url !== 'string') throw new ConfigError('"url" is missing');
  const limits = limitsOf(config);
  const res = await http.get(config.url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', robots: true });
  const items = parseFeed(res.text);
  let n = 0;
  for (const item of items) {
    if (n >= limits.maxJobs) return result(false, true);
    n += 1;
    yield mapItem(item, source);
  }
  return result(config.complete === true && n > 0);
}
