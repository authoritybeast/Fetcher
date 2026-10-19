import * as greenhouse from './greenhouse.mjs';
import * as lever from './lever.mjs';
import * as ashby from './ashby.mjs';
import * as smartrecruiters from './smartrecruiters.mjs';
import * as recruitee from './recruitee.mjs';
import * as usajobs from './usajobs.mjs';
import * as remoteok from './remoteok.mjs';
import * as remotive from './remotive.mjs';
import * as arbeitnow from './arbeitnow.mjs';
import * as rss from './rss.mjs';
import * as jsonFeed from './json-feed.mjs';
import * as jsonld from './jsonld.mjs';

/** source.kind -> connector module (each exports `fetchJobs`) */
export const connectors = Object.freeze({
  greenhouse, lever, ashby, smartrecruiters, recruitee, usajobs, remoteok, remotive, arbeitnow, rss, json_feed: jsonFeed, jsonld,
});
