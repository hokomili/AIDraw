import { readdir, rm, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';

const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  throw new Error(`AIDraw requires Node 24.x for packaging; current runtime is ${process.version}.`);
}

const workspace = resolve(process.cwd());
const metadata = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
if (metadata.name !== 'aidraw') throw new Error('Refusing to clean release output outside the AIDraw workspace.');

const output = resolve(workspace, 'out');
const makeOutput = resolve(output, 'make');
if (dirname(makeOutput) !== output || basename(makeOutput) !== 'make') {
  throw new Error('Refusing to clean an unexpected release-output path.');
}

await rm(makeOutput, { recursive: true, force: true });
const generatedManifests = (await readdir(output, { withFileTypes: true }).catch(() => []))
  .filter((entry) => entry.isFile() && (/^SHA256SUMS(?:-[a-z0-9-]+)?\.txt$/i.test(entry.name) || /^THIRD_PARTY_LICENSES\.(?:json|md)$/i.test(entry.name) || /^RELEASE_PROVENANCE-[a-z0-9-]+\.json$/i.test(entry.name)))
  .map((entry) => entry.name);
for (const filename of generatedManifests) {
  await rm(join(output, filename), { force: true });
}
process.stdout.write(`AIDraw release preflight: cleared ${makeOutput}\n`);
