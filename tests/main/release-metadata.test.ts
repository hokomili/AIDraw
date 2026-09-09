import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('honest release metadata', () => {
  it('uses one pre-v1 workspace version with a changelog and release gate', async () => {
    const root = resolve(process.cwd());
    const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string; devDependencies?: Record<string, string> };
    const corePackage = JSON.parse(await readFile(resolve(root, 'packages/core/package.json'), 'utf8')) as { version: string };
    const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
    const checklist = await readFile(resolve(root, 'docs/RELEASE_CHECKLIST.md'), 'utf8');

    expect(rootPackage.version).toMatch(/^0\.\d+\.\d+-[0-9A-Za-z.-]+$/);
    expect(corePackage.version).toBe(rootPackage.version);
    expect(rootPackage.devDependencies?.['@aidraw/core']).toBe(rootPackage.version);
    expect(changelog).toContain(`## [${rootPackage.version}]`);
    expect(checklist).toContain('Stable v1 gate');
    expect(checklist).toContain('Computer Use QA');
  });

  it('defines native package and CI targets for every desktop OS', async () => {
    const root = resolve(process.cwd());
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    const forge = await readFile(resolve(root, 'forge.config.ts'), 'utf8');
    const ci = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
    const release = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8');
    for (const maker of ['maker-squirrel', 'maker-deb', 'maker-rpm', 'maker-zip']) {
      expect(packageJson.devDependencies?.[`@electron-forge/${maker}`]).toBe('7.11.2');
      expect(forge).toContain(`@electron-forge/${maker}`);
    }
    expect(packageJson.devDependencies?.['@electron-forge/maker-base']).toBe('7.11.2');
    expect(packageJson.devDependencies?.['@electron-forge/maker-dmg']).toBeUndefined();
    expect(forge).toContain("from './scripts/safe-dmg-maker.mjs'");
    expect(forge).toContain("new SafeDmgMaker({ name: 'AIDraw' }, ['darwin'])");
    expect(forge).not.toContain('@electron-forge/maker-dmg');
    for (const runner of ['windows-latest', 'macos-latest', 'ubuntu-latest']) expect(ci).toContain(runner);
    expect(ci.match(/node scripts\/check-portability\.mjs/g)).toHaveLength(2);
    expect(release).toContain('name: Desktop release');
    expect(release).toContain('SHA256SUMS-${{ matrix.platform }}.txt');
    expect(release).toContain('node-platform: darwin');
    expect(release).toContain('node-arch: arm64');
    expect(release).toContain('node scripts/check-portability.mjs --expect-platform=${{ matrix.node-platform }} --expect-arch=${{ matrix.node-arch }}');
    expect(forge).toContain("resetAdHocDarwinSignature: platform === 'darwin' && arch === 'arm64'");
  });

  it('gates verification on deterministic tracked and prospective-path portability checks', async () => {
    const root = resolve(process.cwd());
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const attributes = await readFile(resolve(root, '.gitattributes'), 'utf8');
    expect(packageJson.scripts?.['check:portability']).toBe('node scripts/check-portability.mjs --include-untracked');
    expect(packageJson.scripts?.verify).toMatch(/^npm run check:portability &&/);
    expect(attributes).toContain('* text=auto eol=lf');
    expect(attributes).toContain('*.ps1 text eol=crlf');
  });

  it('keeps Paper external so its optional jsdom integration stays optional', async () => {
    const root = resolve(process.cwd());
    const viteMain = await readFile(resolve(root, 'vite.main.config.ts'), 'utf8');
    const forge = await readFile(resolve(root, 'forge.config.ts'), 'utf8');
    expect(viteMain).toContain("external: ['electron', '@napi-rs/canvas', 'paper']");
    expect(forge).toContain("'/node_modules/paper'");
  });

  it('pins workflow actions and limits release write authority to the publishing job', async () => {
    const root = resolve(process.cwd());
    const ci = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
    const release = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8');
    expect(`${ci}\n${release}`).not.toMatch(/uses:\s+[^@\s]+@v\d+\b/);
    expect(ci).toContain('persist-credentials: false');
    expect(release).toContain('persist-credentials: false');
    expect(release).toMatch(/permissions:\r?\n\s+contents: read/);
    expect(release).toContain("branches: ['codex/rc1']");
    expect(release).toContain("release:\n    if: startsWith(github.ref, 'refs/tags/v')");
    expect(release).toMatch(/release:\r?\n[\s\S]*?permissions:\r?\n\s+contents: write/);
  });
});
