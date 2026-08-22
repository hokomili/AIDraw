import { basename, dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';
import type { ExportFormat } from '../common/contracts';
import { exportDocument, normalizeExportScale, type ExportArtifact } from './export-document';
import { ExportPublicationRefusalError, publishExportSet } from './export-publication';
import { readNativeDocument } from './persistence';
import { RasterUtilitySupervisor } from './utility-supervisor';
import type { ImageDecodeValidator } from './transaction-policy';

const formats: ExportFormat[] = ['png', 'jpeg', 'webp', 'svg', 'pdf', 'psd', 'gif', 'apng', 'sprite-sheet', 'tiled-json', 'tiled-xml'];

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'batch-export'; inputPath: string; outputPath: string; format?: ExportFormat; scale: number; animationTag?: string; paletteCycle?: string; paletteCycleFrame?: string; overwrite: boolean };

export interface BatchExportResult {
  inputPath: string;
  outputPath: string;
  companionPaths: string[];
  format: ExportFormat;
  scale: number;
  byteLength: number;
  warnings: string[];
}

export const CLI_EXIT_CODES = {
  success: 0,
  runtimeFailure: 1,
  refusal: 2,
} as const;

export class CliRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliRefusalError';
  }
}

export type StartupCommand = 'mcp-bridge' | 'cli' | 'quit-engine' | 'headless' | 'show';

function assertNoSplitUserDataDirectory(arguments_: string[]): void {
  if (arguments_.includes('--user-data-dir')) {
    throw new CliRefusalError('The app-owned profile selector must use the unambiguous --user-data-dir=<profile> form.');
  }
}

export interface CliInvocationOptions {
  command: CliCommand | undefined;
  parseError?: Error;
  version: string;
  executable?: string;
  writeStdout?: (message: string) => void;
  writeStderr?: (message: string) => void;
  executeBatch?: typeof executeBatchExport;
}

/**
 * Electron consumes this app-owned profile selector while AIDraw still sees it
 * in process.argv. Keep it available to main.ts for app.setPath(), but do not
 * reinterpret it as a batch-export option.
 */
export function selectCliArguments(arguments_: string[]): string[] {
  assertNoSplitUserDataDirectory(arguments_);
  return arguments_.filter((argument) => !argument.startsWith('--user-data-dir='));
}

export function selectStartupCommand(
  arguments_: string[],
  cliInvocation: boolean,
  cliParseFailed: boolean,
): StartupCommand {
  if (cliParseFailed) return 'cli';
  if (arguments_.includes('--mcp-bridge')) return 'mcp-bridge';
  if (cliInvocation) return 'cli';
  if (arguments_.includes('--quit-engine')) return 'quit-engine';
  if (arguments_.includes('--headless')) return 'headless';
  return 'show';
}

function nextValue(arguments_: string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith('-')) throw new CliRefusalError(`${option} requires a value.`);
  return value;
}

export function parseCliArguments(arguments_: string[]): CliCommand | undefined {
  assertNoSplitUserDataDirectory(arguments_);
  const isCli = arguments_.some((argument) => ['-b', '--batch', '-h', '--help', '--version'].includes(argument));
  if (!isCli) return undefined;
  if (arguments_.includes('-h') || arguments_.includes('--help')) return { kind: 'help' };
  if (arguments_.includes('--version')) return { kind: 'version' };

  let outputPath: string | undefined; let format: ExportFormat | undefined; let scale = 1; let animationTag: string | undefined; let paletteCycle: string | undefined; let paletteCycleFrame: string | undefined; let overwrite = false; let batch = false;
  const positional: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '-b' || argument === '--batch') batch = true;
    else if (argument === '--overwrite') overwrite = true;
    else if (argument === '--save-as') { outputPath = nextValue(arguments_, index, argument); index += 1; }
    else if (argument === '--scale') {
      try { scale = normalizeExportScale(nextValue(arguments_, index, argument)); }
      catch (error) { throw new CliRefusalError(error instanceof Error ? error.message : String(error)); }
      index += 1;
    }
    else if (argument === '--animation-tag') { animationTag = nextValue(arguments_, index, argument).trim(); if (!animationTag || animationTag.length > 120) throw new CliRefusalError('--animation-tag must contain from 1 to 120 characters.'); index += 1; }
    else if (argument === '--palette-cycle') { paletteCycle = nextValue(arguments_, index, argument).trim(); if (!paletteCycle || paletteCycle.length > 120) throw new CliRefusalError('--palette-cycle must contain from 1 to 120 characters.'); index += 1; }
    else if (argument === '--palette-cycle-frame') { paletteCycleFrame = nextValue(arguments_, index, argument).trim(); if (!paletteCycleFrame || paletteCycleFrame.length > 120) throw new CliRefusalError('--palette-cycle-frame must contain from 1 to 120 characters.'); index += 1; }
    else if (argument === '--format') {
      const value = nextValue(arguments_, index, argument);
      if (!formats.includes(value as ExportFormat)) throw new CliRefusalError(`Unknown export format “${value}”.`);
      format = value as ExportFormat; index += 1;
    } else if (argument.startsWith('-')) throw new CliRefusalError(`Unknown CLI option “${argument}”.`);
    else positional.push(argument);
  }
  if (!batch) throw new CliRefusalError('Batch export requires --batch or -b.');
  if (positional.length !== 1) throw new CliRefusalError(`Batch export requires exactly one input .aidraw file; received ${positional.length}.`);
  if (!outputPath) throw new CliRefusalError('Batch export requires --save-as <output>.');
  const paletteCycleRequested = paletteCycle !== undefined || paletteCycleFrame !== undefined;
  if (paletteCycleRequested && (!paletteCycle || !paletteCycleFrame)) throw new CliRefusalError('Palette-cycle export requires both --palette-cycle and --palette-cycle-frame.');
  if (paletteCycleRequested && animationTag) throw new CliRefusalError('Choose either --animation-tag or a palette cycle, not both.');
  return { kind: 'batch-export', inputPath: positional[0], outputPath, format, scale, animationTag, paletteCycle, paletteCycleFrame, overwrite };
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
    '  --animation-tag <id/name>  Export one exact ID or unambiguous name (GIF/APNG/sprite-sheet)',
    '  --palette-cycle <id/name>  Exact cycle; GIF requires 10 ms step multiples',
    '  --palette-cycle-frame <id/name>  Exact source frame for --palette-cycle',
    '  --overwrite          Replace every admitted member of the complete output set',
    '  -h, --help           Show this help',
    '  --version            Show the AIDraw version',
    '',
    'Tiled JSON/XML destinations use .tmj/.tmx for maps or .tsj/.tsx for tilesets.',
    'Exit codes: 0 help/version/export success; 2 argument or validation refusal; 1 read/export/publication/runtime failure.',
    '',
    'Examples:',
    `  ${executable} -b slime.aidraw --scale 8 --save-as slime-x8.gif`,
    `  ${executable} -b hero.aidraw --format sprite-sheet --scale 4 --save-as hero-x4.png`,
    `  ${executable} -b hero.aidraw --format sprite-sheet --palette-cycle "Glow" --palette-cycle-frame "Idle" --save-as glow.png`,
  ].join('\n');
}

function inferFormat(filePath: string): ExportFormat | undefined {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg';
  if (extension === '.tmj' || extension === '.tsj') return 'tiled-json';
  if (extension === '.tmx' || extension === '.tsx') return 'tiled-xml';
  const value = extension.slice(1);
  return formats.includes(value as ExportFormat) && value !== 'sprite-sheet' ? value as ExportFormat : undefined;
}

function extensionMatches(format: ExportFormat, filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  if (!extension) return true;
  if (format === 'jpeg') return extension === '.jpg' || extension === '.jpeg';
  if (format === 'sprite-sheet') return extension === '.png';
  if (format === 'tiled-json') return extension === '.tmj' || extension === '.tsj';
  if (format === 'tiled-xml') return extension === '.tmx' || extension === '.tsx';
  return extension === `.${format}`;
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

function resolveExactOrUniqueNamed<T extends { id: string; name: string }>(entries: T[], selector: string, label: string, idLabel: string): T {
  const exactId = entries.find((entry) => entry.id === selector);
  const named = exactId ? [] : entries.filter((entry) => entry.name.toLocaleLowerCase() === selector.toLocaleLowerCase());
  if (!exactId && named.length > 1) throw new CliRefusalError(`${label} name “${selector}” is ambiguous; use an exact ${idLabel} ID.`);
  const selected = exactId ?? named[0];
  if (!selected) throw new CliRefusalError(`${label} “${selector}” does not exist.`);
  return selected;
}

export async function executeBatchExport(
  command: Extract<CliCommand, { kind: 'batch-export' }>,
  imageDecoder?: ImageDecodeValidator,
): Promise<BatchExportResult> {
  const ownedUtilities = imageDecoder ? undefined : new RasterUtilitySupervisor();
  const decode = imageDecoder ?? ((bytes, expected) => ownedUtilities!.validateImage(bytes, expected));
  try {
    const inputPath = resolve(command.inputPath);
    if (extname(inputPath).toLowerCase() !== '.aidraw') throw new CliRefusalError('Batch export input must be an .aidraw file.');
    const format = command.format ?? inferFormat(command.outputPath);
    if (!format) throw new CliRefusalError('Cannot infer the export format. Add --format <format>.');
    if (!extensionMatches(format, command.outputPath)) throw new CliRefusalError(`The output extension does not match --format ${format}.`);
    const paletteCycleRequested = command.paletteCycle !== undefined || command.paletteCycleFrame !== undefined;
    if (paletteCycleRequested && (!command.paletteCycle || !command.paletteCycleFrame)) throw new CliRefusalError('Palette-cycle export requires both --palette-cycle and --palette-cycle-frame.');
    if (paletteCycleRequested && command.animationTag) throw new CliRefusalError('Choose either --animation-tag or a palette cycle, not both.');
    if (paletteCycleRequested && !['gif', 'apng', 'sprite-sheet'].includes(format)) {
      throw new CliRefusalError('--palette-cycle requires a GIF, APNG, or sprite-sheet export from a pixel sprite.');
    }
    if (command.animationTag && !['gif', 'apng', 'sprite-sheet'].includes(format)) {
      throw new CliRefusalError('--animation-tag requires a GIF, APNG, or sprite-sheet export from a pixel sprite.');
    }
    const loaded = await readNativeDocument(inputPath, decode);
    let animationTagId: string | undefined; let paletteCycleId: string | undefined; let paletteCycleFrameId: string | undefined;
    if (command.animationTag || paletteCycleRequested) {
      if (loaded.document.kind !== 'pixel') throw new CliRefusalError(`${paletteCycleRequested ? '--palette-cycle' : '--animation-tag'} requires a GIF, APNG, or sprite-sheet export from a pixel sprite.`);
      const sprite = loaded.document.pixelAssets[loaded.document.activeAssetId];
      if (sprite.type !== 'sprite') throw new CliRefusalError(`${paletteCycleRequested ? '--palette-cycle' : '--animation-tag'} requires an active pixel sprite.`);
      if (command.animationTag) animationTagId = resolveExactOrUniqueNamed(sprite.tags, command.animationTag, 'Animation tag', 'tag').id;
      if (paletteCycleRequested) {
        const cycle = resolveExactOrUniqueNamed(loaded.document.paletteCycles, command.paletteCycle!, 'Palette cycle', 'cycle');
        const frame = resolveExactOrUniqueNamed(sprite.frameIds.map((frameId) => sprite.frames[frameId]), command.paletteCycleFrame!, 'Palette-cycle frame', 'frame');
        if (format === 'gif' && cycle.stepMs % 10 !== 0) throw new CliRefusalError(`Palette cycle “${cycle.name}” uses ${cycle.stepMs} ms steps, which GIF cannot represent exactly; export APNG or use a 10-millisecond multiple.`);
        paletteCycleId = cycle.id;
        paletteCycleFrameId = frame.id;
      }
    }
    const artifact = await exportDocument(loaded.document, format, { scale: command.scale, animationTagId, paletteCycleId, paletteCycleFrameId });
    const requested = resolve(command.outputPath);
    if ((format === 'tiled-json' || format === 'tiled-xml') && extname(requested)
      && extname(requested).toLowerCase() !== `.${artifact.extension}`) {
      throw new CliRefusalError(`The active Tiled asset exports as .${artifact.extension}; the requested destination uses ${extname(requested)}.`);
    }
    const target = extname(requested) ? requested : `${requested}.${artifact.extension}`;
    const entries = outputEntries(artifact, format, target);
    const publishedPaths = await publishExportSet(entries, command.overwrite);
    return {
      inputPath,
      outputPath: target,
      companionPaths: publishedPaths.slice(1),
      format,
      scale: command.scale,
      byteLength: artifact.data.byteLength,
      warnings: [...loaded.warnings, ...artifact.report.warnings],
    };
  } finally {
    ownedUtilities?.stop();
  }
}

export async function runCliInvocation(options: CliInvocationOptions): Promise<number> {
  const executable = options.executable ?? 'AIDraw.exe';
  const stdout = options.writeStdout ?? ((message: string) => { process.stdout.write(message); });
  const stderr = options.writeStderr ?? ((message: string) => { process.stderr.write(message); });
  try {
    if (options.parseError) throw options.parseError;
    if (options.command?.kind === 'help') stdout(`${cliHelp(executable)}\n`);
    else if (options.command?.kind === 'version') stdout(`${options.version}\n`);
    else if (options.command?.kind === 'batch-export') {
      const execute = options.executeBatch ?? executeBatchExport;
      stdout(`${JSON.stringify(await execute(options.command), null, 2)}\n`);
    } else throw new CliRefusalError('No AIDraw CLI command was provided.');
    return CLI_EXIT_CODES.success;
  } catch (error) {
    const exitCode = error instanceof CliRefusalError || error instanceof ExportPublicationRefusalError
      ? CLI_EXIT_CODES.refusal
      : CLI_EXIT_CODES.runtimeFailure;
    stderr(`AIDraw CLI: ${error instanceof Error ? error.message : String(error)}\n\n${cliHelp(executable)}\n`);
    return exitCode;
  }
}
