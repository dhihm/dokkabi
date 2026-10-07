/** Snapshot preparation only. Never imports private history or publishes a ref. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

type Component = 'harness' | 'app';
const harnessTrees = new Set(['src', 'plugins', 'prompts', 'packages', 'runners', 'market', 'resources', 'bin']);
const appTrees = new Set(['apps', 'packages', 'scripts', 'assets', 'native', 'patches', 'packaging', 'infra', 'oxlint-plugin-t3code', 'licenses', '.vite-hooks']);
const harnessFiles = new Set(['LICENSE', 'SECURITY.md', 'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'scripts/desktop-child.ts', 'scripts/test.ts', 'scripts/test-environment.ts', 'scripts/prepare-public-release.ts', 'scripts/lib/public-release.ts', 'tests/preload.ts', 'tests/public-release.test.ts', 'tests/workbench-models.test.ts', 'tests/current-model-catalog.test.ts', 'tests/tool-schema-compatibility.test.ts', 'tests/transcript-provenance.test.ts', 'tests/fixtures/provider-input-fixture.ts', 'tests/replay-state-original.test.ts', 'tests/plugin-lifecycle-replay.test.ts', 'tests/event-log-lock.test.ts', 'tests/seal-outcome.test.ts', 'tests/manifest-capability-closure.test.ts']);
const appFiles = new Set(['LICENSE', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'vite.config.ts', 'knip.json', 't3.json', 'rust-toolchain.toml', 'third-party-licenses.config.json']);
const publicDocs = new Map([['docs/public/README.0.1.0.md', 'README.md'], ['docs/public/SECURITY.0.1.0.md', 'SECURITY.md'], ['docs/public/BUILD.0.1.0.md', 'BUILD.md'], ['docs/public/CONTRIBUTING.0.1.0.md', 'CONTRIBUTING.md'], ['docs/public/APP.0.1.0.md', 'app/README.md'], ['docs/public/UPSTREAM.0.1.0.md', 'app/UPSTREAM.md']]);

export function isPublicSourcePath(component: Component, file: string): boolean {
  if (!file || file.includes('\\') || file.includes('\0') || isAbsolute(file)) return false;
  const parts = file.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /^(?:\.git|\.github|\.repos|\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials?\.json|profiles?|sessions?|node_modules|dist|dist-electron|target|\.dokkabi|\.pi)$/u.test(p))) return false;
  return component === 'harness'
    ? harnessFiles.has(file) || harnessTrees.has(parts[0]!) || publicDocs.has(file)
    : appFiles.has(file) || appTrees.has(parts[0]!);
}
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
}
async function inspect(repo: string, component: Component, ref = 'HEAD') {
  const revision = git(repo, 'rev-parse', '--verify', `${ref}^{commit}`).toString().trim();
  const blobs = new Map<string, string>();
  const modes = new Map<string, number>();
  const files = git(repo, 'ls-tree', '-r', '-z', '--full-tree', revision).toString().split('\0').filter(Boolean).flatMap(record => {
    const tab = record.indexOf('\t'); const path = record.slice(tab + 1);
    if (!isPublicSourcePath(component, path)) return [];
    if (!/^100(?:644|755) blob [a-f0-9]+$/u.test(record.slice(0, tab))) throw Error(`Public payload requires regular files: ${component}/${path}`);
    blobs.set(path, record.slice(0, tab).split(' ')[2]!);
    modes.set(path, record.startsWith('100755') ? 0o755 : 0o644);
    return [path];
  });
  const read = (path: string) => git(repo, 'show', `${revision}:${path}`);
  const required = component === 'harness' ? ['LICENSE', 'package.json', 'bun.lock', 'src/cli.ts', 'scripts/desktop-child.ts', ...publicDocs.keys()] : ['LICENSE', 'pnpm-lock.yaml', 'package.json', 'apps/desktop/package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/contracts/package.json'];
  for (const path of required) if (!files.includes(path)) throw Error(`Missing required ${component} source: ${path}`);
  const versions = (component === 'harness' ? ['package.json'] : required.filter(p => p.endsWith('package.json') && p !== 'package.json')).map(path => JSON.parse(read(path).toString()).version as string);
  return { revision, files, blobs, modes, read, versions };
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
    await writeFile(join(scratch, '.gitignore'), 'node_modules/\n.env\n.env.*\n.dokkabi/\nsessions/\ndist/\ndist-electron/\nrelease/\ntarget/\n*.log\n*.tsbuildinfo\n.DS_Store\n');
    const manifest: PublicReleaseManifest = { schema: 1, version, sourceLayout: { harness: '.', app: 'app' }, files: await fileInventory(scratch) };
    await writeFile(join(scratch, 'PUBLIC-SNAPSHOT.json'), JSON.stringify(manifest, null, 2) + '\n');
    await mkdir(dirname(receipt), { recursive: true });
    await writeFile(receipt, JSON.stringify({ schema: 1, harnessRevision: harness.revision, appRevision: app.revision, manifestSha256: createHash('sha256').update(JSON.stringify(manifest, null, 2) + '\n').digest('hex') }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(scratch, destination);
    return manifest;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
