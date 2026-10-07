// Path scoping, ignore rules, secret-file exclusion and content redaction.
// Everything here is pure so it can be unit-tested without touching disk.

import path from 'node:path';

export const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

// Directory names that are never descended into, anywhere in the tree.
export const IGNORED_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor',
  'dist', 'build', 'out', 'coverage', 'tmp', 'temp',
  '.git', '.hg', '.svn', '.dashboard-data', '.next', '.nuxt', '.cache', '.turbo',
  '.parcel-cache', '.yarn', '.pnpm-store', '.idea', '.vscode',
  'secrets', '.secrets', '.ssh', '.aws', '.gnupg', '.docker', '.kube',
]);

// File names that look like credentials. These are never read, hashed or stored.
export const SECRET_FILE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p8|p12|pfx|crt|cer|der|jks|keystore|asc|gpg|kdbx|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|yarnrc|netrc|pypirc|pgpass|htpasswd)$/i,
  /(^|[._-])(secret|secrets|credential|credentials|password|passwords|passwd|apikey|api-key|private-key)([._-]|$)/i,
  /(^|[._-])(token|tokens)\.(json|js|ts|txt)$/i,
];

export const IGNORE_FILE_NAMES = ['.gitignore', '.dashboardignore'];

/** Normalize a watcher/relative path to posix form. Returns null if it escapes the root. */
export function normalizeRelPath(rel) {
  if (rel == null) return null;
  let p = String(rel).replace(/\\/g, '/');
  if (p.includes('\0')) return null;
  if (path.posix.isAbsolute(p)) return null;
  p = path.posix.normalize(p);
  if (p === '.' || p === '') return '';
  if (p === '..' || p.startsWith('../')) return null;
  return p.replace(/\/+$/, '');
}

/** True when `child` (absolute) is the same as or inside `parent` (absolute). */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isSecretFileName(name) {
  return SECRET_FILE_PATTERNS.some((re) => re.test(name));
}

export function isSupportedSource(relPath) {
  if (relPath.endsWith('.d.ts') || relPath.endsWith('.d.mts') || relPath.endsWith('.d.cts')) return false;
  return SUPPORTED_EXTENSIONS.has(path.posix.extname(relPath).toLowerCase());
}

/**
 * Builds a matcher from .gitignore-style text. Supported: comments, `dir/`,
 * `/anchored`, `*`, `?`, `**`. Negations (`!pattern`) are deliberately ignored
 * so the matcher can only ever exclude more, never re-include secrets.
 */
export function compileIgnore(text) {
  const rules = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let pat = line;
    const dirOnly = pat.endsWith('/');
    if (dirOnly) pat = pat.slice(0, -1);
    const anchored = pat.startsWith('/') || pat.includes('/');
    if (pat.startsWith('/')) pat = pat.slice(1);
    if (!pat) continue;
    let re = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === '*') {
        if (pat[i + 1] === '*') {
          i++;
          if (pat[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
        } else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    const body = anchored ? `^${re}` : `(?:^|/)${re}`;
    rules.push(new RegExp(`${body}(?:/.*)?$`));
  }
  return (relPath) => rules.some((re) => re.test(relPath));
}

/**
 * Decide whether a root-relative path must be skipped. Applies to both files
 * and directories (any excluded ancestor excludes the descendant).
 */
export function isExcludedPath(relPath, ignoreMatcher = null) {
  if (!relPath) return false;
  for (const seg of relPath.split('/')) {
    // Hidden entries (.git, .env, .ssh, ...) are never source we want to read.
    if (seg.startsWith('.')) return true;
    if (IGNORED_DIRS.has(seg)) return true;
    if (isSecretFileName(seg)) return true;
  }
  if (ignoreMatcher && ignoreMatcher(relPath)) return true;
  return false;
}

const REDACTED = '«redacted»';
const REDACTION_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
const ASSIGNMENT_PATTERN = /((?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)[\w-]*["']?\s*[:=]\s*)(["'`])([^"'`\n]{6,})\2/gi;

/**
 * Replace secret-looking literals while preserving line structure, so
 * line-based symbol ranges and diffs stay aligned with the original file.
 */
export function redactSecrets(text) {
  let out = String(text);
  for (const re of REDACTION_PATTERNS) {
    out = out.replace(re, (m) => m.replace(/[^\n]+/g, REDACTED));
  }
  out = out.replace(ASSIGNMENT_PATTERN, (_m, key, q) => `${key}${q}${REDACTED}${q}`);
  return out;
}
