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
});
