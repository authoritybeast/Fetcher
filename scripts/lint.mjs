// Dependency-free lint: syntax check of every .mjs file plus a few project rules that matter for a public repo.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const problems = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(root);
for (const f of files.filter((x) => x.endsWith('.mjs'))) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`${relative(root, f)}: syntax error\n${String(e.stderr || e.message).split('\n').slice(0, 4).join('\n')}`);
  }
}

// Rules for code that runs in production (src/)
const RULES = [
  [/\beval\s*\(/, 'eval() is not allowed'],
  [/\bnew\s+Function\s*\(/, 'new Function() is not allowed'],
  [/\bconsole\.(log|info|warn|error|debug)\s*\(/, 'use the logger (src/log.mjs), never console.*: it redacts secrets'],
  [/process\.env\.(INGEST_TOKEN|INGEST_URL|USAJOBS_API_KEY)[^;\n]*\b(log|console)\b/, 'a secret must never be logged'],
  [/\.supabase\.co/, 'no project URL in the repo'],
  [/eyJ[A-Za-z0-9_-]{20,}/, 'looks like a JWT'],
  [/\bsb_(secret|publishable)_[A-Za-z0-9_-]+/, 'looks like a Supabase key'],
];
for (const f of files.filter((x) => /\/src\/.*\.mjs$/.test(x))) {
  const text = readFileSync(f, 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const [re, msg] of RULES) if (re.test(line)) problems.push(`${relative(root, f)}:${i + 1}: ${msg}`);
  });
}

// Secrets anywhere in the repo (tests and fixtures included)
for (const f of files.filter((x) => !x.includes('package-lock') && !x.endsWith('lint.mjs'))) {
  const text = readFileSync(f, 'utf8');
  if (/eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}/.test(text) || /\bsb_secret_/.test(text) || /[a-z0-9]{20}\.supabase\.co/.test(text)) problems.push(`${relative(root, f)}: contains something that looks like a secret or a project URL`);
}

// Third-party actions must be pinned to a full commit SHA
for (const f of files.filter((x) => x.includes('.github/workflows/'))) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const m = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
    if (m && !m[1].startsWith('./') && !/@[0-9a-f]{40}$/.test(m[1])) problems.push(`${relative(root, f)}:${i + 1}: action is not pinned to a full commit SHA (${m[1]})`);
  });
}

if (problems.length) {
  process.stderr.write(`${problems.join('\n')}\n\nlint: ${problems.length} problem(s)\n`);
  process.exit(1);
}
process.stdout.write(`lint: ${files.filter((x) => x.endsWith('.mjs')).length} files ok\n`);
