/** Snapshot preparation only. Never imports private history or publishes a ref. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

type Component = 'harness' | 'app';
const harnessTrees = new Set(['src', 'plugins', 'prompts', 'packages', 'runners', 'market', 'resources', 'bin']);
const appTrees = new Set(['apps', 'packages', 'scripts', 'assets', 'native', 'patches', 'packaging', 'infra', 'oxlint-plugin-t3code', 'licenses', '.vite-hooks']);
const harnessFiles = new Set(['LICENSE', 'SECURITY.md', 'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'scripts/desktop-child.ts', 'scripts/test.ts', 'scripts/test-environment.ts', 'scripts/prepare-public-release.ts', 'scripts/lib/public-release.ts', 'tests/preload.ts', 'tests/public-release.test.ts', 'tests/workbench-models.test.ts', 'tests/current-model-catalog.test.ts', 'tests/tool-schema-compatibility.test.ts', 'tests/transcript-provenance.test.ts', 'tests/fixtures/provider-input-fixture.ts', 'tests/replay-state-original.test.ts', 'tests/plugin-lifecycle-replay.test.ts', 'tests/event-log-lock.test.ts', 'tests/seal-outcome.test.ts', 'tests/manifest-capability-closure.test.ts', 'tests/desktop-child.test.ts', 'tests/security-pairing.test.ts', 'tests/desktop-server-chat.test.ts', 'tests/workbench-gateway.test.ts', 'tests/desktop-branch-server.contract-review.test.ts']);
const appFiles = new Set(['LICENSE', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'vite.config.ts', 'knip.json', 't3.json', 'rust-toolchain.toml', 'third-party-licenses.config.json']);
// Private plugin package ids come from a committed config that is itself never
// exported (scripts/ is allowlisted file by file), so the names stay private.
const privatePluginConfig = 'scripts/public-release-private.json';
const publicDocs = new Map([['docs/public/README.0.1.0.md', 'README.md'], ['docs/public/SECURITY.0.1.0.md', 'SECURITY.md'], ['docs/public/BUILD.0.1.0.md', 'BUILD.md'], ['docs/public/CONTRIBUTING.0.1.0.md', 'CONTRIBUTING.md'], ['docs/public/APP.0.1.0.md', 'app/README.md'], ['docs/public/UPSTREAM.0.1.0.md', 'app/UPSTREAM.md']]);

export function loadInternalOperatorCodenames(repoRoot: string): readonly string[] {
  const path = join(repoRoot, 'scripts/lib/operator-legacy-aliases.json');
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { internalCodenames?: unknown };
    if (!Array.isArray(parsed.internalCodenames)) {
      return [];
    }
    return parsed.internalCodenames
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim().toLowerCase());
  } catch {
    return [];
  }
}

export function textContainsInternalOperatorCodename(
  text: string,
  codenames: readonly string[],
): boolean {
  if (codenames.length === 0) {
    return false;
  }
  const lower = text.toLowerCase();
  return codenames.some((name) => lower.includes(name));
}

function normalizeForbiddenExportSubstrings(terms: unknown, source: string): readonly string[] {
  if (terms === undefined) {
    return [];
  }
  if (!Array.isArray(terms) || terms.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw Error(`Invalid forbiddenExportSubstrings in ${source}`);
  }
  return terms.map((entry) => entry.trim().toLowerCase());
}

function isGitRepository(repo: string): boolean {
  try {
    const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    return realpathSync(repo) === realpathSync(toplevel);
  } catch {
    return false;
  }
}

export function readExportForbiddenSubstrings(repo: string, revision: string): readonly string[] {
  git(repo, 'rev-parse', '--verify', `${revision}^{commit}`);
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${revision}:${privatePluginConfig}`], { stdio: 'ignore' });
  } catch {
    return [];
  }
  const text = git(repo, 'show', `${revision}:${privatePluginConfig}`).toString();
  const parsed = JSON.parse(text) as { forbiddenExportSubstrings?: unknown };
  return normalizeForbiddenExportSubstrings(parsed.forbiddenExportSubstrings, privatePluginConfig);
}

/** Resolve forbidden export terms for shipped self-checks (git checkout or extracted snapshot). */
export function readExportForbiddenSubstringsForSelfCheck(repoRoot: string): readonly string[] {
  if (isGitRepository(repoRoot)) {
    return readExportForbiddenSubstrings(repoRoot, 'HEAD');
  }
  const localConfig = join(repoRoot, privatePluginConfig);
  if (existsSync(localConfig)) {
    const parsed = JSON.parse(readFileSync(localConfig, 'utf8')) as { forbiddenExportSubstrings?: unknown };
    return normalizeForbiddenExportSubstrings(parsed.forbiddenExportSubstrings, privatePluginConfig);
  }
  return [];
}

export function textContainsExportForbiddenSubstring(
  text: string,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) {
    return false;
  }
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function exportForbiddenOffenders(
  files: readonly string[],
  read: (path: string) => Buffer,
  terms: readonly string[],
): string[] {
  return files.filter(
    (path) =>
      textContainsExportForbiddenSubstring(path, terms)
      || textContainsExportForbiddenSubstring(read(path).toString(), terms),
  );
}

/** Read every harness public-source blob at `ref` in one git cat-file batch. */
export function harnessPublicSourceTextsAtRevision(
  repoRoot: string,
  ref = 'HEAD',
): Map<string, string> {
  const revision = git(repoRoot, 'rev-parse', '--verify', `${ref}^{commit}`).toString().trim();
  const privatePlugins = readPrivatePlugins(repoRoot, revision);
  const records = git(repoRoot, 'ls-tree', '-r', '-z', '--full-tree', revision).toString().split('\0').filter(Boolean);
  const files: { path: string; sha: string }[] = [];
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const path = record.slice(tab + 1);
    if (!isPublicSourcePath('harness', path, privatePlugins)) continue;
    if (!/^100(?:644|755) blob [a-f0-9]+$/u.test(record.slice(0, tab))) continue;
    files.push({ path, sha: record.slice(0, tab).split(' ')[2]! });
  }
  const texts = new Map<string, string>();
  if (files.length === 0) {
    return texts;
  }
  const batchOut = execFileSync('git', ['-C', repoRoot, 'cat-file', '--batch'], {
    input: files.map((file) => file.sha).join('\n') + '\n',
    maxBuffer: 256 * 1024 * 1024,
  });
  let cursor = 0;
  for (const file of files) {
    const newline = batchOut.indexOf(10, cursor);
    const header = batchOut.subarray(cursor, newline).toString();
    const match = /^([a-f0-9]+) blob (\d+)$/u.exec(header);
    if (!match || match[1] !== file.sha) {
      throw Error(`Frozen Git blob response mismatch for ${file.path}`);
    }
    const size = Number(match[2]);
    const body = batchOut.subarray(newline + 1, newline + 1 + size);
    if (body.length !== size || batchOut[newline + 1 + size] !== 10) {
      throw Error(`Truncated Git blob for ${file.path}`);
    }
    texts.set(file.path, body.toString('utf8'));
    cursor = newline + 2 + size;
  }
  if (cursor !== batchOut.length) {
    throw Error('Unexpected trailing data in git cat-file batch');
  }
  return texts;
}

const deniedHarnessTreeSegment = /^(?:\.git|\.github|\.repos|\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials?\.json|profiles?|sessions?|node_modules|dist|dist-electron|target|\.dokkabi|\.pi)$/u;

function harnessPublicSourceTextsFromTree(
  repoRoot: string,
  privatePlugins: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const texts = new Map<string, string>();
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name);
      const relativePath = relative(repoRoot, absolute).split('\\').join('/');
      const lst = lstatSync(absolute);
      if (lst.isSymbolicLink()) {
        continue;
      }
      if (lst.isDirectory()) {
        if (relativePath === 'app' || relativePath.startsWith('app/')) {
          continue;
        }
        if (relativePath.split('/').some((part) => deniedHarnessTreeSegment.test(part))) {
          continue;
        }
        walk(absolute);
        continue;
      }
      if (!lst.isFile()) {
        continue;
      }
      if (!isPublicSourcePath('harness', relativePath, privatePlugins)) {
        continue;
      }
      texts.set(relativePath, readFileSync(absolute, 'utf8'));
    }
  };
  walk(repoRoot);
  return texts;
}

/** Read exportable harness sources for self-checks (git checkout or extracted snapshot). */
export function harnessPublicSourceTexts(repoRoot: string): Map<string, string> {
  if (isGitRepository(repoRoot)) {
    return harnessPublicSourceTextsAtRevision(repoRoot);
  }
  return harnessPublicSourceTextsFromTree(repoRoot);
}

export function isPublicSourcePath(component: Component, file: string, privatePlugins: ReadonlySet<string> = new Set()): boolean {
  if (!file || file.includes('\\') || file.includes('\0') || isAbsolute(file)) return false;
  const parts = file.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /^(?:\.git|\.github|\.repos|\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials?\.json|profiles?|sessions?|node_modules|dist|dist-electron|target|\.dokkabi|\.pi)$/u.test(p))) return false;
  if (component === 'harness' && parts[0] === 'plugins' && parts.length > 2 && privatePlugins.has(parts[1]!)) return false;
  return component === 'harness'
    ? harnessFiles.has(file) || harnessTrees.has(parts[0]!) || publicDocs.has(file)
    : appFiles.has(file) || appTrees.has(parts[0]!);
}
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
}
export function readPrivatePlugins(repo: string, revision: string): Set<string> {
  git(repo, 'rev-parse', '--verify', `${revision}^{commit}`);
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${revision}:${privatePluginConfig}`], { stdio: 'ignore' });
  } catch {
    return new Set();
  }
  const text = git(repo, 'show', `${revision}:${privatePluginConfig}`).toString();
  const ids = (JSON.parse(text) as { plugins?: unknown }).plugins;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(id))) throw Error(`Invalid ${privatePluginConfig}`);
  return new Set(ids as string[]);
}
function isPrivatePluginEntry(entry: unknown, privatePlugins: ReadonlySet<string>): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const { id, package: pkg } = entry as { id?: unknown; package?: unknown };
  return (typeof id === 'string' && privatePlugins.has(id)) || (typeof pkg === 'string' && privatePlugins.has(pkg.split('/')[0]!));
}
function withoutPrivatePlugins(value: unknown, privatePlugins: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.filter(e => !isPrivatePluginEntry(e, privatePlugins)).map(e => withoutPrivatePlugins(e, privatePlugins));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutPrivatePlugins(v, privatePlugins)]));
  return value;
}
/** Drop private package entries from exported plugin manifests; untouched manifests keep committed bytes. */
async function scrubPrivatePluginEntries(pluginsDir: string, privatePlugins: ReadonlySet<string>) {
  if (privatePlugins.size === 0) return;
  for (const name of await readdir(pluginsDir)) {
    if (!/^manifest(?:\.[\w-]+)*\.json$/u.test(name)) continue;
    const path = join(pluginsDir, name);
    const before = JSON.parse(await readFile(path, 'utf8'));
    const after = withoutPrivatePlugins(before, privatePlugins);
    if (JSON.stringify(after) !== JSON.stringify(before)) await writeFile(path, JSON.stringify(after, null, 2) + '\n');
  }
  for (const name of await readdir(pluginsDir)) {
    if (!name.endsWith('.json')) continue;
    const text = await readFile(join(pluginsDir, name), 'utf8');
    for (const id of privatePlugins) if (text.includes(`"${id}/`) || text.includes(`"${id}"`)) throw Error(`Private plugin still referenced: plugins/${name}`);
  }
}
async function inspect(repo: string, component: Component, ref = 'HEAD') {
  const revision = git(repo, 'rev-parse', '--verify', `${ref}^{commit}`).toString().trim();
  const privatePlugins = component === 'harness' ? readPrivatePlugins(repo, revision) : new Set<string>();
  const blobs = new Map<string, string>();
  const modes = new Map<string, number>();
  const files = git(repo, 'ls-tree', '-r', '-z', '--full-tree', revision).toString().split('\0').filter(Boolean).flatMap(record => {
    const tab = record.indexOf('\t'); const path = record.slice(tab + 1);
    if (!isPublicSourcePath(component, path, privatePlugins)) return [];
    if (!/^100(?:644|755) blob [a-f0-9]+$/u.test(record.slice(0, tab))) throw Error(`Public payload requires regular files: ${component}/${path}`);
    blobs.set(path, record.slice(0, tab).split(' ')[2]!);
    modes.set(path, record.startsWith('100755') ? 0o755 : 0o644);
    return [path];
  });
  const read = (path: string) => git(repo, 'show', `${revision}:${path}`);
  const required = component === 'harness' ? ['LICENSE', 'package.json', 'bun.lock', 'src/cli.ts', 'scripts/desktop-child.ts', ...publicDocs.keys()] : ['LICENSE', 'pnpm-lock.yaml', 'package.json', 'apps/desktop/package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/contracts/package.json'];
  for (const path of required) if (!files.includes(path)) throw Error(`Missing required ${component} source: ${path}`);
  const versions = (component === 'harness' ? ['package.json'] : required.filter(p => p.endsWith('package.json') && p !== 'package.json')).map(path => JSON.parse(read(path).toString()).version as string);
  return { revision, files, blobs, modes, read, versions, privatePlugins };
}
export interface PublicReleaseManifest {
  schema: 1; version: string; sourceLayout: { harness: '.'; app: 'app' };
  files: { path: string; size: number; sha256: string }[];
}
async function fileInventory(root: string, directory = root): Promise<PublicReleaseManifest['files']> {
  const files: PublicReleaseManifest['files'] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await fileInventory(root, path));
    else if (entry.isFile()) { const bytes = await readFile(path); files.push({ path: relative(root, path).split('\\').join('/'), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
    else throw Error('Non-regular exported payload');
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function exportPublicRelease(input: { harness: string; app: string; harnessRef?: string; appRef?: string; destination: string; receipt: string }): Promise<PublicReleaseManifest> {
  const destination = resolve(input.destination); const receipt = resolve(input.receipt);
  for (const repo of [input.harness, input.app]) if (destination === resolve(repo) || destination.startsWith(resolve(repo) + '/')) throw Error('Export must be outside source checkouts');
  if (receipt === destination || receipt.startsWith(destination + '/')) throw Error('Private receipt must remain outside public payload');
  try { await lstat(destination); throw Error('Public destination already exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const harness = await inspect(input.harness, 'harness', input.harnessRef);
  const app = await inspect(input.app, 'app', input.appRef);
  const codenames = loadInternalOperatorCodenames(input.harness);
  if (codenames.length > 0) {
    const offenders = harness.files.filter((path) =>
      textContainsInternalOperatorCodename(harness.read(path).toString(), codenames),
    );
    if (offenders.length > 0) {
      throw Error(`Internal operator codenames in public export: ${offenders.join(', ')}`);
    }
  }
  const forbidden = readExportForbiddenSubstrings(input.harness, harness.revision);
  if (forbidden.length > 0) {
    const harnessOffenders = exportForbiddenOffenders(harness.files, harness.read, forbidden);
    const appOffenders = exportForbiddenOffenders(app.files, app.read, forbidden);
    const offenders = [...harnessOffenders, ...appOffenders.map((path) => `app/${path}`)];
    if (offenders.length > 0) {
      throw Error(`Forbidden public-release substrings in export: ${offenders.join(', ')}`);
    }
  }
  const version = harness.versions[0]!;
  if (!/^\d+\.\d+\.\d+$/u.test(version) || [...harness.versions, ...app.versions].some(v => v !== version)) throw Error('Harness/app version mismatch');
  await mkdir(dirname(destination), { recursive: true });
  const scratch = await mkdtemp(join(dirname(destination), '.public-export-'));
  try {
    for (const [component, source] of [['harness', harness], ['app', app]] as const) {
      const target = component === 'harness' ? scratch : join(scratch, 'app');
      await mkdir(target, { recursive: true });
      // git archive applies committed EOL/export attributes. Read raw blobs
      // instead so source bytes never acquire substitutions or normalization.
      const repo = component === 'harness' ? input.harness : input.app;
      for (let offset = 0; offset < source.files.length; offset += 128) {
        const batch = source.files.slice(offset, offset + 128);
        const bytes = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
          input: batch.map(file => source.blobs.get(file)!).join('\n') + '\n',
          maxBuffer: 256 * 1024 * 1024,
        });
        let cursor = 0;
        for (const file of batch) {
          const newline = bytes.indexOf(10, cursor);
          const header = bytes.subarray(cursor, newline).toString();
          const match = /^([a-f0-9]+) blob (\d+)$/u.exec(header);
          if (!match || match[1] !== source.blobs.get(file)) throw Error('Frozen Git blob response mismatch');
          const size = Number(match[2]);
          const body = bytes.subarray(newline + 1, newline + 1 + size);
          const expected = source.blobs.get(file)!;
          const actual = createHash(expected.length === 64 ? 'sha256' : 'sha1').update(`blob ${size}\0`).update(body).digest('hex');
          if (body.length !== size || actual !== expected || bytes[newline + 1 + size] !== 10) throw Error(`Altered frozen Git blob: ${component}/${file}`);
          const path = join(target, file);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, body, { flag: 'wx', mode: source.modes.get(file)! });
          cursor = newline + 2 + size;
        }
        if (cursor !== bytes.length) throw Error('Unexpected frozen Git blob data');
      }
    }
    for (const [source, target] of publicDocs) await writeFile(join(scratch, target), harness.read(source));
    await rm(join(scratch, 'docs'), { recursive: true, force: true });
    // Nested app tests belong to pnpm/Vite, never the harness's Bun suite.
    const packagePath = join(scratch, 'package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    pkg.scripts = { start: 'bun src/cli.ts', dokkabi: 'bun src/cli.ts', test: 'bun --no-env-file scripts/test.ts ./tests', typecheck: 'bun node_modules/typescript/bin/tsc --noEmit -p .' };
    await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n');
    await scrubPrivatePluginEntries(join(scratch, 'plugins'), harness.privatePlugins);
    await writeFile(join(scratch, '.gitignore'), 'node_modules/\n.env\n.env.*\n.dokkabi/\nsessions/\ndist/\ndist-electron/\nrelease/\ntarget/\n*.log\n*.tsbuildinfo\n.DS_Store\n');
    const manifest: PublicReleaseManifest = {
      schema: 1,
      version,
      sourceLayout: { harness: '.', app: 'app' },
      files: await fileInventory(scratch),
    };
    await writeFile(join(scratch, 'PUBLIC-SNAPSHOT.json'), JSON.stringify(manifest, null, 2) + '\n');
    await mkdir(dirname(receipt), { recursive: true });
    await writeFile(receipt, JSON.stringify({ schema: 1, harnessRevision: harness.revision, appRevision: app.revision, manifestSha256: createHash('sha256').update(JSON.stringify(manifest, null, 2) + '\n').digest('hex') }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(scratch, destination);
    return manifest;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
