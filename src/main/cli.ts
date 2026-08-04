import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';
import type { ExportFormat } from '../common/contracts';
import { exportDocument, normalizeExportScale, type ExportArtifact } from './export-document';
import { readNativeDocument } from './persistence';

const formats: ExportFormat[] = ['png', 'jpeg', 'webp', 'svg', 'pdf', 'psd', 'gif', 'apng', 'sprite-sheet', 'tiled-json', 'tiled-xml'];

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'batch-export'; inputPath: string; outputPath: string; format?: ExportFormat; scale: number; animationTag?: string; overwrite: boolean };

export interface BatchExportResult {
  inputPath: string;
  outputPath: string;
  companionPaths: string[];
  format: ExportFormat;
  scale: number;
  byteLength: number;
  warnings: string[];
}

function nextValue(arguments_: string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}

export function parseCliArguments(arguments_: string[]): CliCommand | undefined {
  const isCli = arguments_.some((argument) => ['-b', '--batch', '-h', '--help', '--version'].includes(argument));
  if (!isCli) return undefined;
  if (arguments_.includes('-h') || arguments_.includes('--help')) return { kind: 'help' };
  if (arguments_.includes('--version')) return { kind: 'version' };

  let outputPath: string | undefined; let format: ExportFormat | undefined; let scale = 1; let animationTag: string | undefined; let overwrite = false; let batch = false;
  const positional: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '-b' || argument === '--batch') batch = true;
    else if (argument === '--overwrite') overwrite = true;
    else if (argument === '--save-as') { outputPath = nextValue(arguments_, index, argument); index += 1; }
    else if (argument === '--scale') { scale = normalizeExportScale(nextValue(arguments_, index, argument)); index += 1; }
    else if (argument === '--animation-tag') { animationTag = nextValue(arguments_, index, argument).trim(); if (!animationTag || animationTag.length > 120) throw new Error('--animation-tag must contain from 1 to 120 characters.'); index += 1; }
    else if (argument === '--format') {
      const value = nextValue(arguments_, index, argument);
      if (!formats.includes(value as ExportFormat)) throw new Error(`Unknown export format “${value}”.`);
      format = value as ExportFormat; index += 1;
    } else if (argument.startsWith('-')) throw new Error(`Unknown CLI option “${argument}”.`);
    else positional.push(argument);
  }
  if (!batch) throw new Error('Batch export requires --batch or -b.');
  if (positional.length !== 1) throw new Error(`Batch export requires exactly one input .aidraw file; received ${positional.length}.`);
  if (!outputPath) throw new Error('Batch export requires --save-as <output>.');
  return { kind: 'batch-export', inputPath: positional[0], outputPath, format, scale, animationTag, overwrite };
}

export function cliHelp(executable = 'AIDraw.exe'): string {
  return [
    'AIDraw command line',
    '',
    `Usage: ${executable} --batch <input.aidraw> --save-as <output> [options]`,
    '',
    'Options:',
    '  -b, --batch          Export without opening the editor or starting the MCP engine',
    '  --save-as <path>     Exact output path',
    '  --format <format>    Optional explicit format (required for sprite-sheet)',
    '  --scale <1-64>       Integer nearest-neighbor scale for pixel presentation exports',
    '  --animation-tag <id/name>  Export one exact sprite tag range (GIF/APNG/sprite-sheet)',
    '  --overwrite          Replace an existing exact output path',
    '  -h, --help           Show this help',
    '  --version            Show the AIDraw version',
    '',
    'Examples:',
    `  ${executable} -b slime.aidraw --scale 8 --save-as slime-x8.gif`,
    `  ${executable} -b hero.aidraw --format sprite-sheet --scale 4 --save-as hero-x4.png`,
  ].join('\n');
}

function inferFormat(filePath: string): ExportFormat | undefined {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg';
  if (extension === '.tmj') return 'tiled-json';
  if (extension === '.tmx') return 'tiled-xml';
  const value = extension.slice(1);
  return formats.includes(value as ExportFormat) && value !== 'sprite-sheet' ? value as ExportFormat : undefined;
}

function extensionMatches(format: ExportFormat, filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  if (!extension) return true;
  if (format === 'jpeg') return extension === '.jpg' || extension === '.jpeg';
  if (format === 'sprite-sheet') return extension === '.png';
  if (format === 'tiled-json') return extension === '.tmj';
  if (format === 'tiled-xml') return extension === '.tmx';
  return extension === `.${format}`;
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

function companionBytes(data: Buffer, format: ExportFormat, target: string): Buffer {
  if (format !== 'sprite-sheet') return data;
  try {
    const metadata = JSON.parse(data.toString('utf8')) as { meta?: Record<string, unknown> };
    metadata.meta = { ...(metadata.meta ?? {}), image: basename(target) };
    return Buffer.from(JSON.stringify(metadata, null, 2));
  } catch { return data; }
}

function outputEntries(artifact: ExportArtifact, format: ExportFormat, target: string): Array<{ path: string; data: Buffer }> {
  const entries = [{ path: target, data: artifact.data }];
  for (const companion of artifact.companions ?? []) entries.push({ path: join(dirname(target), companion.name), data: companionBytes(companion.data, format, target) });
  if (artifact.companion) {
    const path = artifact.companion.name
      ? join(dirname(target), artifact.companion.name)
      : `${target.slice(0, -extname(target).length)}.${artifact.companion.extension}`;
    entries.push({ path, data: companionBytes(artifact.companion.data, format, target) });
  }
  return entries;
}

async function atomicWrite(filePath: string, data: Buffer, overwrite: boolean): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const present = await exists(filePath);
  if (present && !overwrite) throw new Error(`Output already exists: ${filePath}. Pass --overwrite to replace it.`);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${filePath}.${process.pid}.${Date.now()}.bak`;
  await writeFile(temporary, data, { flag: 'wx' });
  let backedUp = false;
  try {
    if (present) { await rename(filePath, backup); backedUp = true; }
    await rename(temporary, filePath);
    if (backedUp) await unlink(backup);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (backedUp) await rename(backup, filePath).catch(() => undefined);
    throw error;
  }
}

export async function executeBatchExport(command: Extract<CliCommand, { kind: 'batch-export' }>): Promise<BatchExportResult> {
  const inputPath = resolve(command.inputPath);
  if (extname(inputPath).toLowerCase() !== '.aidraw') throw new Error('Batch export input must be an .aidraw file.');
  const loaded = await readNativeDocument(inputPath);
  const format = command.format ?? inferFormat(command.outputPath);
  if (!format) throw new Error('Cannot infer the export format. Add --format <format>.');
  if (!extensionMatches(format, command.outputPath)) throw new Error(`The output extension does not match --format ${format}.`);
  let animationTagId: string | undefined;
  if (command.animationTag) {
    if (!['gif', 'apng', 'sprite-sheet'].includes(format) || loaded.document.kind !== 'pixel') throw new Error('--animation-tag requires a GIF, APNG, or sprite-sheet export from a pixel sprite.');
    const sprite = loaded.document.pixelAssets[loaded.document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('--animation-tag requires an active pixel sprite.'); const tag = sprite.tags.find((entry) => entry.id === command.animationTag || entry.name.toLocaleLowerCase() === command.animationTag!.toLocaleLowerCase()); if (!tag) throw new Error(`Animation tag “${command.animationTag}” does not exist.`); animationTagId = tag.id;
  }
  const artifact = await exportDocument(loaded.document, format, { scale: command.scale, animationTagId });
  const requested = resolve(command.outputPath);
  const target = extname(requested) ? requested : `${requested}.${artifact.extension}`;
  const entries = outputEntries(artifact, format, target);
  if (!command.overwrite) for (const entry of entries) if (await exists(entry.path)) throw new Error(`Output already exists: ${entry.path}. Pass --overwrite to replace it.`);
  for (const entry of entries) await atomicWrite(entry.path, entry.data, command.overwrite);
  return {
    inputPath,
    outputPath: target,
    companionPaths: entries.slice(1).map((entry) => entry.path),
    format,
    scale: command.scale,
    byteLength: artifact.data.byteLength,
    warnings: [...loaded.warnings, ...artifact.report.warnings],
  };
}
