import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { assertPackageOutputAvailable } from './package-output-policy.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  throw new Error(`AIDraw requires Node 24.x for packaging; current runtime is ${process.version}.`);
}

const workspace = resolve(process.cwd());
const metadata = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
if (metadata.name !== 'aidraw') throw new Error('Refusing package preparation outside the AIDraw workspace.');

const output = await assertPackageOutputAvailable({ workspace });
process.stdout.write(`AIDraw release preflight: fresh package-generation root ${output.relativeOutputDirectory}\n`);
