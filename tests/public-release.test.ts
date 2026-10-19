import { describe, expect, test } from 'bun:test';
import { access, mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  exportPublicRelease,
  harnessPublicSourceTextsAtRevision,
  isPublicSourcePath,
  loadInternalOperatorCodenames,
  readExportForbiddenSubstrings,
  textContainsExportForbiddenSubstring,
  textContainsInternalOperatorCodename,
} from '../scripts/lib/public-release.ts';

const fixturePrivatePluginId = ['private', 'fixture'].join('-');
const fixturePublicPluginId = ['public', 'fixture'].join('-');
const privateConfigRelPath = ['scripts/public-release', 'private.json'].join('-');
const fixturePrivateHarnessRepo = ['dokkabi', 'dev'].join('-');
const fixturePrivateAppRepo = ['dokkabi', 'app'].join('-');

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.exitCode) throw Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function commitHarness(harness: string, message: string) {
  git(harness, 'add', '.');
  git(harness, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message);
}

function fixturePluginJson(id: string) {
  return JSON.stringify({ schema_version: 1, id, module: 'provider.ts' }, null, 2) + '\n';
}

async function seedPrivatePluginHarness(harness: string) {
  const privateId = fixturePrivatePluginId;
  const publicId = fixturePublicPluginId;
  const exportedSelfTest = await readFile(join(import.meta.dir, 'public-release.test.ts'), 'utf8');
  const files: Record<string, string> = {
    'tests/public-release.test.ts': exportedSelfTest,
    [privateConfigRelPath]: JSON.stringify({ plugins: [privateId] }, null, 2) + '\n',
    [`plugins/${privateId}/plugin.json`]: fixturePluginJson(privateId),
    [`plugins/${privateId}/provider.ts`]: 'export const plugin = {};\n',
    [`plugins/${publicId}/plugin.json`]: fixturePluginJson(publicId),
    [`plugins/${publicId}/provider.ts`]: 'export const plugin = {};\n',
    'plugins/manifest.json': JSON.stringify({
      schema_version: 1,
      plugins: [
        { id: privateId, package: `${privateId}/plugin.json` },
        { id: publicId, package: `${publicId}/plugin.json` },
      ],
    }, null, 2) + '\n',
  };
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(harness, path, '..'), { recursive: true });
    await writeFile(join(harness, path), contents);
  }
  await commitHarness(harness, 'Private plugin fixture');
}

async function fixture(run: (root: string, harness: string, app: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dokkabi-public-fixture-'));
  try {
    const harness = join(root, 'harness'); const app = join(root, 'app');
    for (const repo of [harness, app]) {
      await mkdir(repo); await git(repo, 'init');
      const files: Record<string, string> = {
        'package.json': JSON.stringify({ name: repo === harness ? 'dokkabi' : 'app', version: '0.1.0' }),
        'LICENSE': 'MIT fixture', 'README.md': 'Private checkout',
        '.env': 'SECRET=private-fixture', '.github/workflows/release.yml': 'private workflow',
        'docs/private.md': 'Private host fixture',
        ...(repo === harness ? { 'src/cli.ts': 'export {};', 'bun.lock': '{}', 'docs/public/README.0.1.0.md': '# Dokkabi public', 'docs/public/SECURITY.0.1.0.md': '# Security', 'docs/public/BUILD.0.1.0.md': '# Build', 'docs/public/CONTRIBUTING.0.1.0.md': '# Contributing fixture', 'docs/public/APP.0.1.0.md': '# App', 'docs/public/UPSTREAM.0.1.0.md': '# Upstream', 'scripts/desktop-child.ts': 'export {};' } : { 'apps/desktop/package.json': '{"version":"0.1.0"}', 'apps/server/package.json': '{"version":"0.1.0"}', 'apps/web/package.json': '{"version":"0.1.0"}', 'packages/contracts/package.json': '{"version":"0.1.0"}', 'pnpm-lock.yaml': 'fixture lock', '.repos/reference/secret.txt': 'excluded reference' }),
      };
      for (const [path, contents] of Object.entries(files)) { await mkdir(join(repo, path, '..'), { recursive: true }); await writeFile(join(repo, path), contents); }
      git(repo, 'add', '.'); git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
    }
    await run(root, harness, app);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('public snapshot boundaries', () => {
  test('internal codename guard matches underscore and camelCase substrings', () => {
    const synthetic = ['acmecode'] as const;
    expect(textContainsInternalOperatorCodename('DOKKABI_ACMECODE_GPU1_BASE_URL', synthetic)).toBe(true);
    expect(textContainsInternalOperatorCodename('release_acmecode_35b', synthetic)).toBe(true);
    expect(textContainsInternalOperatorCodename('AcmecodeIssue', synthetic)).toBe(true);
    expect(textContainsInternalOperatorCodename('operator-gpu1', synthetic)).toBe(false);
  });

  test('legacy alias codename list stays outside the public export allowlist', () => {
    expect(isPublicSourcePath('harness', 'scripts/lib/operator-legacy-aliases.json')).toBe(false);
  });

  test('forbidden export substring config stays outside the public export allowlist', () => {
    expect(isPublicSourcePath('harness', privateConfigRelPath)).toBe(false);
  });

  test('export forbidden substring guard matches case-insensitive substrings', () => {
    const terms = readExportForbiddenSubstrings(join(import.meta.dirname, '..'), 'HEAD');
    if (terms.length === 0) {
      expect(terms).toEqual([]);
      return;
    }
    const sample = terms[0]!;
    expect(textContainsExportForbiddenSubstring(sample.toUpperCase(), terms)).toBe(true);
    expect(textContainsExportForbiddenSubstring(`prefix-${sample}-suffix`, terms)).toBe(true);
    expect(textContainsExportForbiddenSubstring('operator-public-tree', terms)).toBe(false);
  });

  test('exported harness source contains no forbidden public-release substrings', () => {
    const repoRoot = join(import.meta.dirname, '..');
    const terms = readExportForbiddenSubstrings(repoRoot, 'HEAD');
    if (terms.length === 0) {
      expect(terms).toEqual([]);
      return;
    }
    const sources = harnessPublicSourceTextsAtRevision(repoRoot);
    const offenders = [...sources.entries()]
      .filter(([path, text]) =>
        textContainsExportForbiddenSubstring(path, terms)
        || textContainsExportForbiddenSubstring(text, terms),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  test('exported harness source contains no internal operator codenames', () => {
    const repoRoot = join(import.meta.dirname, '..');
    const codenames = loadInternalOperatorCodenames(repoRoot);
    if (codenames.length === 0) {
      expect(codenames).toEqual([]);
      return;
    }
    const sources = harnessPublicSourceTextsAtRevision(repoRoot);
    const offenders = [...sources.entries()].filter(([, text]) =>
      textContainsInternalOperatorCodename(text, codenames),
    ).map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  test('excludes private metadata and reference trees even inside allowed trees', () => {
    for (const path of ['.git/config', '.github/workflows/release.yml', 'src/auth.json', 'src/.env', 'src/profiles/operator.json', '../escape', '/absolute', 'src/link/../../escape', 'src/sessions/log.jsonl']) expect(isPublicSourcePath('harness', path)).toBe(false);
    expect(isPublicSourcePath('app', '.repos/source/README.md')).toBe(false);
    expect(isPublicSourcePath('harness', 'src/cli.ts')).toBe(true);
    expect(isPublicSourcePath('app', 'apps/web/src/main.tsx')).toBe(true);
  });
  test('excludes listed private plugin trees from the harness allowlist', () => {
    const privatePlugins = new Set(['private-fixture']);
    expect(isPublicSourcePath('harness', 'plugins/private-fixture/plugin.json', privatePlugins)).toBe(false);
    expect(isPublicSourcePath('harness', 'plugins/public-fixture/plugin.json', privatePlugins)).toBe(true);
  });
  test('exports frozen objects, excludes internal content, produces deterministic hashes and refuses reuse', async () => fixture(async (root, harness, app) => {
    await writeFile(join(harness, 'src/cli.ts'), 'uncommitted operator data');
    await writeFile(join(app, 'pnpm-lock.yaml'), 'unowned lock change');
    const output = join(root, 'public');
    const first = await exportPublicRelease({ harness, app, destination: output, receipt: join(root, 'receipt.json') });
    expect(await readFile(join(output, 'src/cli.ts'), 'utf8')).toBe('export {};');
    expect(await readFile(join(output, 'app/pnpm-lock.yaml'), 'utf8')).toBe('fixture lock');
    expect(await readFile(join(output, 'README.md'), 'utf8')).toBe('# Dokkabi public');
    expect(await readFile(join(output, 'CONTRIBUTING.md'), 'utf8')).toBe('# Contributing fixture');
    expect(first.files.some(f => /(?:private|\.env|\.github|\.repos|\.git\/)/.test(f.path))).toBe(false);
    expect(first.files.some(f => f.path === 'app/LICENSE')).toBe(true);
    const second = await exportPublicRelease({ harness, app, destination: join(root, 'second'), receipt: join(root, 'second-receipt.json') });
    expect(second).toEqual(first);
    await expect(exportPublicRelease({ harness, app, destination: output, receipt: join(root, 'third-receipt.json') })).rejects.toThrow(/exists/);
    expect(await readFile(join(app, 'pnpm-lock.yaml'), 'utf8')).toBe('unowned lock change');
    expect(JSON.stringify(first)).not.toContain(harness);
    const receipt = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'));
    expect(receipt.manifestSha256).toBe(createHash('sha256').update(await readFile(join(output, 'PUBLIC-SNAPSHOT.json'))).digest('hex'));
    expect(JSON.parse(await readFile(join(output, 'package.json'), 'utf8')).scripts.test).toEndWith('./tests');
  }));
  test('rejects selected symlinks before any payload is delivered', async () => fixture(async (root, harness, app) => {
    await symlink('/etc/passwd', join(harness, 'src/link.ts'));
    git(harness, 'add', '.'); git(harness, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Link fixture');
    await expect(exportPublicRelease({ harness, app, destination: join(root, 'public'), receipt: join(root, 'receipt.json') })).rejects.toThrow(/regular/);
  }));
  test('rejects component version skew', async () => fixture(async (root, harness, app) => {
    await writeFile(join(app, 'apps/web/package.json'), '{"version":"0.2.0"}'); git(app, 'add', '.'); git(app, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Version fixture');
    await expect(exportPublicRelease({ harness, app, destination: join(root, 'public'), receipt: join(root, 'receipt.json') })).rejects.toThrow(/version/);
  }));
  test('harnessPublicSourceTextsAtRevision skips private plugins for codename self-check', async () => fixture(async (_root, harness, _app) => {
    await seedPrivatePluginHarness(harness);
    const privateId = fixturePrivatePluginId;
    const syntheticCodename = `acme${randomUUID().slice(0, 8)}`;
    await writeFile(join(harness, `plugins/${privateId}/provider.ts`), `export const tag = '${syntheticCodename}';\n`);
    await commitHarness(harness, 'Private plugin codename placeholder');

    const sources = harnessPublicSourceTextsAtRevision(harness);
    expect(sources.has(`plugins/${privateId}/provider.ts`)).toBe(false);

    const offenders = [...sources.entries()]
      .filter(([, text]) => textContainsInternalOperatorCodename(text, [syntheticCodename]))
      .map(([path]) => path);
    expect(offenders).toEqual([]);

    await writeFile(join(harness, 'src/codename-fixture.ts'), `export const leak = '${syntheticCodename}';\n`);
    await commitHarness(harness, 'Public path codename placeholder');
    const sourcesAfter = harnessPublicSourceTextsAtRevision(harness);
    const publicOffenders = [...sourcesAfter.entries()]
      .filter(([, text]) => textContainsInternalOperatorCodename(text, [syntheticCodename]))
      .map(([path]) => path);
    expect(publicOffenders).toEqual(['src/codename-fixture.ts']);
  }));

  test('rejects export when a forbidden public-release substring appears in a harness path', async () => fixture(async (root, harness, app) => {
    const pathSegment = fixturePrivateHarnessRepo;
    await writeFile(join(harness, 'src', `${pathSegment}-plain.ts`), 'export {};\n');
    git(harness, 'add', '.');
    git(harness, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Forbidden harness path fixture');
    await mkdir(join(harness, 'scripts'), { recursive: true });
    await writeFile(
      join(harness, privateConfigRelPath),
      JSON.stringify({ plugins: [], forbiddenExportSubstrings: [pathSegment] }, null, 2) + '\n',
    );
    git(harness, 'add', '.');
    git(harness, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Forbidden config fixture');
    await expect(exportPublicRelease({
      harness,
      app,
      destination: join(root, 'public'),
      receipt: join(root, 'receipt.json'),
    })).rejects.toThrow(/Forbidden public-release substrings/u);
  }));

  test('rejects export when a forbidden public-release substring appears in harness source', async () => fixture(async (root, harness, app) => {
    await writeFile(join(harness, 'src/leak.ts'), `export const tag = '${fixturePrivateHarnessRepo}';\n`);
    git(harness, 'add', '.');
    git(harness, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Forbidden harness fixture');
    await mkdir(join(harness, 'scripts'), { recursive: true });
    await writeFile(
      join(harness, privateConfigRelPath),
      JSON.stringify({ plugins: [], forbiddenExportSubstrings: [fixturePrivateHarnessRepo] }, null, 2) + '\n',
    );
    git(harness, 'add', '.');
    git(harness, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Forbidden config fixture');
    await expect(exportPublicRelease({
      harness,
      app,
      destination: join(root, 'public'),
      receipt: join(root, 'receipt.json'),
    })).rejects.toThrow(/Forbidden public-release substrings/u);
  }));

  test('rejects export when a forbidden public-release substring appears in app source', async () => fixture(async (root, harness, app) => {
    await writeFile(join(app, 'apps/web/leak.ts'), `export const tag = '${fixturePrivateAppRepo}';\n`);
    git(app, 'add', '.');
    git(app, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Forbidden app fixture');
    await mkdir(join(harness, 'scripts'), { recursive: true });
    await writeFile(
      join(harness, privateConfigRelPath),
      JSON.stringify({ plugins: [], forbiddenExportSubstrings: [fixturePrivateAppRepo] }, null, 2) + '\n',
    );
    git(harness, 'add', '.');
    git(harness, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Forbidden config fixture');
    await expect(exportPublicRelease({
      harness,
      app,
      destination: join(root, 'public'),
      receipt: join(root, 'receipt.json'),
    })).rejects.toThrow(/Forbidden public-release substrings/u);
  }));

  test('excludes private harness plugins from the exported snapshot', async () => fixture(async (root, harness, app) => {
    const privateId = fixturePrivatePluginId;
    const publicId = fixturePublicPluginId;
    await seedPrivatePluginHarness(harness);
    const output = join(root, 'public');
    await exportPublicRelease({ harness, app, destination: output, receipt: join(root, 'receipt.json') });

    await expect(access(join(output, `plugins/${privateId}/plugin.json`))).rejects.toThrow();

    const manifest = JSON.parse(await readFile(join(output, 'plugins/manifest.json'), 'utf8')) as { plugins: { id: string }[] };
    expect(manifest.plugins.map(entry => entry.id)).toEqual([publicId]);
    expect(await readFile(join(output, `plugins/${publicId}/plugin.json`), 'utf8')).toContain(publicId);

    const exportedTest = await readFile(join(output, 'tests/public-release.test.ts'), 'utf8');
    expect(exportedTest).not.toContain(privateConfigRelPath);

    await writeFile(join(harness, 'plugins/stale-reference.json'), `{"owner":"${privateId}"}\n`);
    await commitHarness(harness, 'Stale private plugin reference');
    await expect(exportPublicRelease({
      harness,
      app,
      destination: join(root, 'public-stale'),
      receipt: join(root, 'receipt-stale.json'),
    })).rejects.toThrow(/Private plugin still referenced/u);
  }));
});

test('preserves raw Git source despite export and line-ending attributes', async () => fixture(async (root, harness, app) => {
  await writeFile(join(harness, '.gitattributes'), 'src/cli.ts export-ignore\n*.cmd text eol=crlf\n');
  await writeFile(join(harness, 'src/fixture.cmd'), 'echo fixture\n');
  git(harness, 'add', '.'); git(harness, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Attribute fixture');
  await exportPublicRelease({ harness, app, destination: join(root, 'public'), receipt: join(root, 'receipt.json') });
  expect(await readFile(join(root, 'public/src/cli.ts'), 'utf8')).toBe('export {};');
  expect(await readFile(join(root, 'public/src/fixture.cmd'), 'utf8')).toBe('echo fixture\n');
}));
