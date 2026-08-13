import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('release license report', () => {
  it('retains hashes plus the complete OFL notice for bundled Canvas font assets', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'aidraw-license-report-')); temporaryDirectories.push(outputDirectory);
    await execFileAsync(process.execPath, ['scripts/license-report.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, AIDRAW_LICENSE_REPORT_OUT_DIR: outputDirectory },
    });
    const inventory = JSON.parse(await readFile(join(outputDirectory, 'THIRD_PARTY_LICENSES.json'), 'utf8')) as Array<{ name: string; version: string; license: string; sourcePackage?: string; assetFiles?: Array<{ fileName: string; sha256: string }> }>;
    expect(inventory.find((record) => record.name === 'pdfjs-dist Liberation Sans font assets')).toEqual({
      name: 'pdfjs-dist Liberation Sans font assets', version: '6.2.108', license: 'OFL-1.1', repository: 'git+https://github.com/mozilla/pdf.js.git', sourcePackage: 'pdfjs-dist@6.2.108', noticePath: 'resources/licenses/LiberationSans-OFL-1.1.txt',
      assetFiles: [
        { fileName: 'LiberationSans-Regular.ttf', sha256: 'f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f' },
        { fileName: 'LiberationSans-Bold.ttf', sha256: '361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc' },
        { fileName: 'LiberationSans-Italic.ttf', sha256: '832b4406dbef23628800d3aaad21048534ac84d7e3ad955be83b8172ed8ef512' },
        { fileName: 'LiberationSans-BoldItalic.ttf', sha256: 'a224075ac17495ad0a3af3bc0a419ac0704a8b3fd1095456201fb9b095fc281d' },
      ],
    });
    const markdown = await readFile(join(outputDirectory, 'THIRD_PARTY_LICENSES.md'), 'utf8');
    expect(markdown).toContain('Digitized data copyright (c) 2010 Google Corporation');
    expect(markdown).toContain('Copyright (c) 2012 Red Hat, Inc.');
    expect(markdown).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});
