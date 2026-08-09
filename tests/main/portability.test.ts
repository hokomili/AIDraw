import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { inspectReleaseHost, inspectRepositoryPaths, type PortabilityReport } from '../../scripts/check-portability.mjs';

const execute = promisify(execFile);

describe('source-control and desktop release portability', () => {
  it('accepts portable paths and rejects case-fold or Unicode-normalization collisions', () => {
    expect(inspectRepositoryPaths(['.github/workflows/ci.yml', 'src/main/main.ts', 'tests/fixtures/terrain.tsx.fixture'])).toEqual([]);
    const violations = inspectRepositoryPaths(['src/Icon.ts', 'src/icon.ts', 'docs/café.md', 'docs/cafe\u0301.md']);
    expect(violations.filter((entry) => entry.code === 'casefold_collision')).toEqual([
      expect.objectContaining({ path: 'docs/café.md', otherPath: 'docs/cafe\u0301.md' }),
      expect.objectContaining({ path: 'src/icon.ts', otherPath: 'src/Icon.ts' }),
    ]);
  });

  it('rejects absolute, unsafe, reserved, generated, and credential-bearing paths', () => {
    const violations = inspectRepositoryPaths([
      '/absolute/source.ts', 'C:/absolute/source.ts', 'src\\wrong-separator.ts', 'src/../escape.ts',
      'src/aux.ts', 'src/trailing.', 'src/name:stream.ts', '.DS_Store', 'out-darwin/AIDraw.app/Contents/app.asar',
      '.codex/SECRETARY_HANDOFF.md', '.env.local', '.npmrc', 'signing/developer-id.p12', 'profile/mcp-token.json', 'profile/credentials/generation.json',
    ]);
    expect(new Set(violations.map((entry) => entry.code))).toEqual(new Set([
      'absolute_path', 'unsafe_separator', 'unsafe_component', 'reserved_device_name', 'trailing_dot_or_space',
      'forbidden_character', 'platform_artifact', 'generated_directory', 'secret_or_credential',
    ]));
  });

  it('fails closed when a release label disagrees with the native Node host', () => {
    expect(inspectReleaseHost('darwin', 'arm64', { platform: 'darwin', architecture: 'arm64' })).toEqual([]);
    expect(inspectReleaseHost('darwin', 'arm64', { platform: 'win32', architecture: 'x64' })).toEqual([
      expect.objectContaining({ code: 'host_platform_mismatch' }),
      expect.objectContaining({ code: 'host_architecture_mismatch' }),
    ]);
  });

  it('keeps attributes, ignore policy, Forge target architecture, and release host checks explicit', async () => {
    const [attributes, ignore, forge, ci, release, packageJson, lockfile, canvasPackage] = await Promise.all([
      readFile(resolve('.gitattributes'), 'utf8'), readFile(resolve('.gitignore'), 'utf8'),
      readFile(resolve('forge.config.ts'), 'utf8'), readFile(resolve('.github/workflows/ci.yml'), 'utf8'),
      readFile(resolve('.github/workflows/release.yml'), 'utf8'), readFile(resolve('package.json'), 'utf8'),
      readFile(resolve('package-lock.json'), 'utf8'), readFile(resolve('packages/canvas/package.json'), 'utf8'),
    ]);
    expect(attributes).toContain('* text=auto eol=lf');
    expect(attributes).toContain('*.ps1 text eol=crlf');
    for (const marker of ['/.codex/', '/.tmp/', '/.tmp-e2e-profile/', '*.mobileprovision', '*.p12', '*.dmg', '*.pkg']) expect(ignore).toContain(marker);
    expect(forge).toContain("resetAdHocDarwinSignature: platform === 'darwin' && arch === 'arm64'");
    expect(forge).toContain('osxSign: macSigningOptions');
    expect(forge).toContain("identity: '-'");
    expect(forge).toContain('AIDRAW_MACOS_SIGN_IDENTITY');
    expect(forge).toContain("appBundleId: macBundleIdentifier");
    expect(forge).toContain('=designated => identifier');
    expect(ci.match(/node scripts\/check-portability\.mjs/g)).toHaveLength(2);
    expect(release).toContain('node scripts/check-portability.mjs --expect-platform=${{ matrix.node-platform }} --expect-arch=${{ matrix.node-arch }}');
    expect(JSON.parse(packageJson).scripts.verify).toMatch(/^npm run check:portability &&/);
    expect(lockfile).toContain('node_modules/@napi-rs/canvas-darwin-arm64');
    expect(lockfile).toContain('node_modules/@napi-rs/canvas-darwin-x64');
    expect(JSON.parse(canvasPackage).dependencies).toEqual({ '@napi-rs/canvas': '1.0.3' });
  });

  it('checks the live tracked and prospective untracked paths through the exact Node CLI', async () => {
    const { stdout } = await execute(process.execPath, [resolve('scripts/check-portability.mjs'), '--include-untracked', '--json'], { cwd: resolve('.'), windowsHide: true });
    const report = JSON.parse(stdout) as PortabilityReport;
    expect(report.trackedCount).toBeGreaterThan(200);
    expect(report.untrackedCount).toBeGreaterThanOrEqual(0);
    expect(report.violations).toEqual([]);
  });
});
