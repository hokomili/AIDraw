#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { promisify, TextDecoder } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const EMPTY_SHA256 = createHash('sha256').digest('hex');
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const decoder = new TextDecoder('utf-8', { fatal: true });

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function parsePorcelainV1Z(output) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
  const records = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const end = bytes.indexOf(0, cursor);
    if (end < 0) throw new Error('Git status output is missing its final NUL terminator.');
    const record = bytes.subarray(cursor, end);
    cursor = end + 1;
    if (record.length < 4 || record[2] !== 0x20) throw new Error('Git status emitted an unsupported porcelain-v1 record.');
    const status = record.subarray(0, 2).toString('ascii');
    const path = decoder.decode(record.subarray(3));
    if (/[RC]/u.test(status)) throw new Error('Rename/copy status is unsupported by this source-subject manifest; materialize the final path state first.');
    if (status !== '??' && status[0] !== ' ') throw new Error('The source-subject manifest requires an empty Git index.');
    if (!path || /[\0\t\r\n]/u.test(path)) throw new Error('Candidate paths must be non-empty UTF-8 without TSV control characters.');
    records.push({ status, path });
  }
  const paths = new Set();
  for (const record of records) {
    if (paths.has(record.path)) throw new Error(`Git status emitted duplicate candidate path ${record.path}.`);
    paths.add(record.path);
  }
  return records.sort((left, right) => compareUtf8(left.path, right.path));
}

async function subjectBytes(root, record) {
  const absolute = resolve(root, record.path);
  const repositoryRelative = relative(resolve(root), absolute);
  if (repositoryRelative === '..' || repositoryRelative.startsWith(`..${sep}`) || isAbsolute(repositoryRelative)) {
    throw new Error(`Candidate path escapes the repository: ${record.path}`);
  }
  if (record.status.includes('D')) return { type: 'deleted', bytes: Buffer.alloc(0) };
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) return { type: 'symlink', bytes: Buffer.from(await readlink(absolute), 'utf8') };
  if (!metadata.isFile()) throw new Error(`Candidate path is not a regular file or symlink: ${record.path}`);
  return { type: 'file', bytes: await readFile(absolute) };
}

export async function buildSourceSubjectManifest(root = repositoryRoot, statusOutput) {
  let porcelain = statusOutput;
  if (porcelain === undefined) {
    const result = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    });
    porcelain = result.stdout;
  }
  const records = parsePorcelainV1Z(porcelain);
  const lines = [];
  for (const record of records) {
    const subject = await subjectBytes(root, record);
    lines.push(`${record.status}\t${subject.type}\t${subject.bytes.byteLength}\t${subject.bytes.byteLength ? sha256(subject.bytes) : EMPTY_SHA256}\t${record.path}\n`);
  }
  return { records, bytes: Buffer.from(lines.join(''), 'utf8') };
}

export function summarizeSourceSubjectManifest(manifest) {
  const counts = { entries: manifest.records.length, modified: 0, deleted: 0, added: 0, other: 0 };
  for (const record of manifest.records) {
    if (record.status === '??' || record.status.includes('A')) counts.added += 1;
    else if (record.status.includes('D')) counts.deleted += 1;
    else if (record.status.includes('M')) counts.modified += 1;
    else counts.other += 1;
  }
  return {
    version: 1,
    encoding: 'UTF-8',
    ordering: 'ascending raw UTF-8 path bytes',
    recordFormat: '<XY>\\t<file|symlink|deleted>\\t<byteLength>\\t<sha256>\\t<path>\\n',
    finalNewline: true,
    ...counts,
    bytes: manifest.bytes.byteLength,
    sha256: sha256(manifest.bytes),
  };
}

async function main() {
  const mode = process.argv[2] ?? 'summary';
  if (mode !== 'summary' && mode !== 'manifest') throw new Error('Usage: node scripts/source-subject-manifest.mjs [summary|manifest]');
  const manifest = await buildSourceSubjectManifest();
  if (mode === 'manifest') process.stdout.write(manifest.bytes);
  else process.stdout.write(`${JSON.stringify(summarizeSourceSubjectManifest(manifest), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
