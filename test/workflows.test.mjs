import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../.github/workflows/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const files = readdirSync(dir);

test('the three workflows exist', () => assert.deepEqual(files.sort(), ['ci.yml', 'fetch.yml', 'keepalive.yml']));

test('every action is pinned to a full commit SHA, and only checkout / setup-node are used', () => {
  for (const f of files) {
    const uses = [...read(f).matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    for (const [, ref, rest] of uses) {
      assert.match(ref, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, `${f}: ${ref}`);
      assert.match(rest, /#\s*v\d/, `${f}: version comment missing for ${ref}`);
    }
  }
  assert.ok(!/uses:/.test(read('keepalive.yml')), 'keepalive uses the gh CLI only');
});

test('fetch.yml: hourly at an odd minute, dispatch inputs, no cancel, read-only, 30 minutes, Node 20', () => {
  const y = read('fetch.yml');
  assert.match(y, /cron: '17 \* \* \* \*'/);
  assert.match(y, /workflow_dispatch:[\s\S]*source_name:[\s\S]*dry_run:/);
  assert.match(y, /concurrency:\s*\n\s+group: fetch\s*\n\s+cancel-in-progress: false/);
  assert.match(y, /permissions:\s*\n\s+contents: read/);
  assert.match(y, /timeout-minutes: 30/);
  assert.match(y, /node-version: 20/);
  assert.match(y, /npm ci/);
  assert.match(y, /run: node src\/index\.mjs/);
});

test('fetch.yml uses exactly the four documented secrets', () => {
  const names = [...new Set([...read('fetch.yml').matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(names, ['INGEST_TOKEN', 'INGEST_URL', 'USAJOBS_API_KEY', 'USAJOBS_EMAIL']);
  for (const f of ['ci.yml', 'keepalive.yml']) assert.ok(!/secrets\.(?!GITHUB_TOKEN)/.test(read(f)), `${f} uses no secrets`);
});

test('workflow inputs reach the program only through env, never inside a script', () => {
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      if (/\$\{\{\s*(github\.event\.|inputs\.)/.test(line)) assert.match(line, /^\s+[A-Z_]+:\s/, `${f}:${i + 1} puts an input outside an env: entry`);
    });
  }
});

test('keepalive.yml: monthly, actions: write only, re-enables fetch.yml with gh', () => {
  const y = read('keepalive.yml');
  assert.match(y, /cron: '\d+ \d+ 1 \* \*'/);
  assert.match(y, /permissions:\s*\n\s+actions: write/);
  assert.match(y, /gh workflow enable fetch\.yml/);
  assert.match(y, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test('ci.yml runs lint and tests on push and pull_request with read-only permissions', () => {
  const y = read('ci.yml');
  assert.match(y, /on:\s*\n\s+push:\s*\n\s+pull_request:/);
  assert.match(y, /npm run lint/);
  assert.match(y, /npm test/);
  assert.match(y, /permissions:\s*\n\s+contents: read/);
});

test('dependabot covers npm and github-actions weekly', () => {
  const y = readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  assert.match(y, /package-ecosystem: npm/);
  assert.match(y, /package-ecosystem: github-actions/);
  assert.equal((y.match(/interval: weekly/g) || []).length, 2);
});
