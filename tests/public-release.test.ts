import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportPublicRelease, isPublicSourcePath } from '../scripts/lib/public-release.ts';

async function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.exitCode) throw Error(result.stderr.toString());
  return result.stdout.toString().trim();
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
      await git(repo, 'add', '.'); await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
    }
    await run(root, harness, app);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('public snapshot boundaries', () => {
  test('excludes private metadata and reference trees even inside allowed trees', () => {
    for (const path of ['.git/config', '.github/workflows/release.yml', 'src/auth.json', 'src/.env', 'src/profiles/operator.json', '../escape', '/absolute', 'src/link/../../escape', 'src/sessions/log.jsonl']) expect(isPublicSourcePath('harness', path)).toBe(false);
    expect(isPublicSourcePath('app', '.repos/source/README.md')).toBe(false);
    expect(isPublicSourcePath('harness', 'src/cli.ts')).toBe(true);
    expect(isPublicSourcePath('app', 'apps/web/src/main.tsx')).toBe(true);
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
    await git(harness, 'add', '.'); await git(harness, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Link fixture');
    await expect(exportPublicRelease({ harness, app, destination: join(root, 'public'), receipt: join(root, 'receipt.json') })).rejects.toThrow(/regular/);
  }));
  test('rejects component version skew', async () => fixture(async (root, harness, app) => {
    await writeFile(join(app, 'apps/web/package.json'), '{"version":"0.2.0"}'); await git(app, 'add', '.'); await git(app, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Version fixture');
    await expect(exportPublicRelease({ harness, app, destination: join(root, 'public'), receipt: join(root, 'receipt.json') })).rejects.toThrow(/version/);
  }));
});

test('preserves raw Git source despite export and line-ending attributes', async () => fixture(async (root, harness, app) => {
  await writeFile(join(harness, '.gitattributes'), 'src/cli.ts export-ignore\n*.cmd text eol=crlf\n');
  await writeFile(join(harness, 'src/fixture.cmd'), 'echo fixture\n');
  await git(harness, 'add', '.'); await git(harness, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Attribute fixture');
  await exportPublicRelease({ harness, app, destination: join(root, 'public'), receipt: join(root, 'receipt.json') });
  expect(await readFile(join(root, 'public/src/cli.ts'), 'utf8')).toBe('export {};');
  expect(await readFile(join(root, 'public/src/fixture.cmd'), 'utf8')).toBe('echo fixture\n');
}));
