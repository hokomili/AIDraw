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
    for (const maker of ['maker-squirrel', 'maker-dmg', 'maker-deb', 'maker-rpm', 'maker-zip']) {
      expect(packageJson.devDependencies?.[`@electron-forge/${maker}`]).toBe('7.11.2');
      expect(forge).toContain(`@electron-forge/${maker}`);
    }
    for (const runner of ['windows-latest', 'macos-latest', 'ubuntu-latest']) expect(ci).toContain(runner);
    expect(release).toContain('name: Desktop release');
    expect(release).toContain('SHA256SUMS-${{ matrix.platform }}.txt');
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
    expect(release).toMatch(/release:\r?\n[\s\S]*?permissions:\r?\n\s+contents: write/);
  });
});
