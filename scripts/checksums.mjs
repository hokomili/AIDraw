import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import process from 'node:process';

const root = join(process.cwd(), 'out');
async function files(directory) { return (await readdir(directory, { withFileTypes: true })).flatMap((entry) => entry.name === 'SHA256SUMS.txt' ? [] : entry.isDirectory() ? [files(join(directory, entry.name))] : [join(directory, entry.name)]); }
async function flatten(values) { const result = []; for (const value of values) result.push(...(value instanceof Promise ? await flatten(await value) : Array.isArray(value) ? await flatten(value) : [value])); return result; }
const artifacts = (await flatten(await files(join(root, 'make')))).sort(); const lines = [];
for (const path of artifacts) lines.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${relative(root, path).replaceAll('\\', '/')}`);
const manifestName = process.env.AIDRAW_CHECKSUM_FILE || 'SHA256SUMS.txt';
if (!/^SHA256SUMS(?:-[a-z0-9-]+)?\.txt$/i.test(manifestName)) throw new Error('Invalid checksum manifest name.');
await writeFile(join(root, manifestName), `${lines.join('\n')}\n`, 'utf8');
