import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { readPackageGeneration, resolvePackageOutputRoot } from './package-output-policy.mjs';

const root = process.cwd();
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const records = [];
// color-convert 0.5.3 predates SPDX metadata in its package manifest. Its npm
// registry metadata and bundled LICENSE both identify it as MIT.
const verifiedLicenseOverrides = new Map([['color-convert@0.5.3', 'MIT']]);
for (const [location, value] of Object.entries(lock.packages ?? {})) {
  if (!location.includes('node_modules/') || !value?.name && !location) continue;
  const name = value.name ?? location.split('node_modules/').at(-1);
  if (!name || !value.version) continue;
  let metadata = value;
  try { metadata = { ...value, ...JSON.parse(await readFile(join(root, location, 'package.json'), 'utf8')) }; } catch { /* Lockfile metadata is the fallback. */ }
  const key = `${name}@${value.version}`;
  const declaredLicense = typeof metadata.license === 'string' ? metadata.license : metadata.license?.type;
  const license = declaredLicense ?? verifiedLicenseOverrides.get(key) ?? 'UNKNOWN';
  records.push({ name, version: value.version, license, repository: typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url });
}
records.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const unique = [...new Map(records.map((record) => [`${record.name}@${record.version}`, record])).values()];
const unknown = unique.filter((record) => record.license === 'UNKNOWN');
if (unknown.length) throw new Error(`Unknown dependency licenses: ${unknown.map((record) => `${record.name}@${record.version}`).join(', ')}`);

const pdfjs = unique.find((record) => record.name === 'pdfjs-dist');
if (!pdfjs) throw new Error('The bundled Canvas fallback font requires pdfjs-dist in the release lockfile.');
const fontDirectory = join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts');
const bundledFontFiles = ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf'];
const fontAssets = await Promise.all(bundledFontFiles.map(async (fileName) => {
  const bytes = await readFile(join(fontDirectory, fileName));
  return { fileName, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const upstreamFontNotice = await readFile(join(fontDirectory, 'LICENSE_LIBERATION'), 'utf8');
const fontNotice = await readFile(join(root, 'resources', 'licenses', 'LiberationSans-OFL-1.1.txt'), 'utf8');
if (fontNotice !== upstreamFontNotice) throw new Error('The packaged Liberation Sans OFL notice differs from the locked pdfjs-dist copy.');
const bundledFontRecord = {
  name: 'pdfjs-dist Liberation Sans font assets',
  version: pdfjs.version,
  license: 'OFL-1.1',
  repository: pdfjs.repository,
  sourcePackage: `pdfjs-dist@${pdfjs.version}`,
  noticePath: 'resources/licenses/LiberationSans-OFL-1.1.txt',
  assetFiles: fontAssets,
};
const inventory = [...unique, bundledFontRecord];
const explicitReportDirectory = process.env.AIDRAW_LICENSE_REPORT_OUT_DIR;
const out = explicitReportDirectory ? resolve(root, explicitReportDirectory) : resolvePackageOutputRoot({ workspace: root });
if (!explicitReportDirectory) {
  await readPackageGeneration({
    workspace: root,
    outputDirectory: out,
    platform: process.env.AIDRAW_PACKAGE_PLATFORM || process.platform,
    architecture: process.env.AIDRAW_PACKAGE_ARCH || process.arch,
  });
}
await writeFile(join(out, 'THIRD_PARTY_LICENSES.json'), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
await writeFile(join(out, 'THIRD_PARTY_LICENSES.md'), `# Third-party dependency licenses\n\nGenerated from the release lockfile. Every entry must have a verified license before publishing.\n\n${unique.map((record) => `- **${record.name}@${record.version}** — ${record.license}${record.repository ? ` — ${record.repository}` : ''}`).join('\n')}\n\n## Bundled font asset notice\n\n- **${bundledFontRecord.name}@${bundledFontRecord.version}** — ${bundledFontRecord.license} — source package ${bundledFontRecord.sourcePackage}\n${fontAssets.map((asset) => `  - \`${asset.fileName}\` — SHA-256 \`${asset.sha256}\``).join('\n')}\n\n### Liberation Sans license and copyright notice\n\n\`\`\`text\n${fontNotice.trimEnd()}\n\`\`\`\n`, 'utf8');
