import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface ExportPublicationEntry {
  path: string;
  data: Buffer;
}

interface ExportPublicationStat {
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  size: number;
  isFile(): boolean;
}

export interface ExportPublicationFileSystem {
  link(existingPath: string, newPath: string): Promise<void>;
  lstat(filePath: string): Promise<ExportPublicationStat>;
  mkdir(directoryPath: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  rename(source: string, destination: string): Promise<void>;
  rmdir(directoryPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  writeFile(filePath: string, data: Buffer, options?: { flag?: string; mode?: number }): Promise<void>;
}

export interface ExportPublicationDependencies {
  fileSystem?: ExportPublicationFileSystem;
  transactionId?: () => string;
}

export class ExportPublicationRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportPublicationRefusalError';
  }
}

const defaultFileSystem: ExportPublicationFileSystem = {
  link: async (existingPath, newPath) => { await link(existingPath, newPath); },
  lstat: async (filePath) => lstat(filePath),
  mkdir: async (directoryPath, options) => { await mkdir(directoryPath, options); },
  readFile: async (filePath) => readFile(filePath),
  rename: async (source, destination) => { await rename(source, destination); },
  rmdir: async (directoryPath) => { await rmdir(directoryPath); },
  unlink: async (filePath) => { await unlink(filePath); },
  writeFile: async (filePath, data, options) => { await writeFile(filePath, data, options); },
};

interface PredecessorSnapshot {
  bytes: Buffer;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  size: number;
}

interface PublicationMember {
  destination: string;
  data: Buffer;
  predecessor?: PredecessorSnapshot;
  stagedPath: string;
  backupPath: string;
  rollbackPath: string;
  state: 'untouched' | 'backed-up' | 'published';
  backupPresent: boolean;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyPresent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

async function optionalStat(fileSystem: ExportPublicationFileSystem, filePath: string): Promise<ExportPublicationStat | undefined> {
  try {
    return await fileSystem.lstat(filePath);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function portablePathIdentity(filePath: string): string {
  return resolve(filePath).normalize('NFC').toLocaleLowerCase('en-US');
}

async function predecessorSnapshot(
  fileSystem: ExportPublicationFileSystem,
  filePath: string,
  overwrite: boolean,
): Promise<PredecessorSnapshot | undefined> {
  const stats = await optionalStat(fileSystem, filePath);
  if (!stats) return undefined;
  if (!stats.isFile()) throw new ExportPublicationRefusalError(`Output is not a regular file: ${filePath}.`);
  if (!overwrite) throw new ExportPublicationRefusalError(`Output already exists: ${filePath}. Pass --overwrite to replace the complete publication set.`);
  return {
    bytes: await fileSystem.readFile(filePath),
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

async function destinationStillMatches(
  fileSystem: ExportPublicationFileSystem,
  destination: string,
  predecessor: PredecessorSnapshot | undefined,
): Promise<boolean> {
  const current = await optionalStat(fileSystem, destination);
  if (!predecessor) return !current;
  if (!current?.isFile()) return false;
  if (current.dev !== predecessor.dev || current.ino !== predecessor.ino || current.mode !== predecessor.mode
    || current.mtimeMs !== predecessor.mtimeMs || current.size !== predecessor.size) return false;
  return (await fileSystem.readFile(destination)).equals(predecessor.bytes);
}

async function removeIfPresent(fileSystem: ExportPublicationFileSystem, filePath: string): Promise<void> {
  try {
    await fileSystem.unlink(filePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanUnpublishedTransaction(
  fileSystem: ExportPublicationFileSystem,
  directoryPath: string,
  members: PublicationMember[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const member of members) {
    for (const filePath of [member.stagedPath, member.backupPath, member.rollbackPath]) {
      try { await removeIfPresent(fileSystem, filePath); } catch (error) { errors.push(error); }
    }
  }
  try { await fileSystem.rmdir(directoryPath); } catch (error) { if (!isMissingFile(error)) errors.push(error); }
  return errors;
}

async function rollbackPublication(
  fileSystem: ExportPublicationFileSystem,
  directoryPath: string,
  members: PublicationMember[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const member of members) {
    if (member.state === 'published') {
      try {
        await removeIfPresent(fileSystem, member.destination);
        if (!member.predecessor) member.state = 'untouched';
      } catch (error) { errors.push(error); }
    }
    if (member.state === 'untouched' || !member.predecessor) continue;
    if (member.state === 'backed-up') {
      try {
        await removeIfPresent(fileSystem, member.backupPath);
        member.backupPresent = false;
        member.state = 'untouched';
      } catch (error) { errors.push(error); }
      continue;
    }
    try {
      if (member.backupPresent) {
        await fileSystem.rename(member.backupPath, member.destination);
        member.backupPresent = false;
      } else {
        await fileSystem.writeFile(member.rollbackPath, member.predecessor.bytes, {
          flag: 'wx',
          mode: member.predecessor.mode & 0o777,
        });
        await fileSystem.rename(member.rollbackPath, member.destination);
      }
      member.state = 'untouched';
    } catch (error) {
      errors.push(error);
    }
  }
  for (const member of members) {
    try { await removeIfPresent(fileSystem, member.stagedPath); } catch (error) { errors.push(error); }
    if (member.state !== 'untouched') continue;
    for (const filePath of [member.backupPath, member.rollbackPath]) {
      try { await removeIfPresent(fileSystem, filePath); } catch (error) { errors.push(error); }
    }
  }
  if (members.every((member) => member.state === 'untouched')) {
    try { await fileSystem.rmdir(directoryPath); } catch (error) { if (!isMissingFile(error)) errors.push(error); }
  }
  return errors;
}

function publicationFailure(primary: unknown, recoveryErrors: unknown[]): Error {
  const recovery = recoveryErrors.length
    ? ` Rollback/cleanup also failed: ${recoveryErrors.map(messageFor).join('; ')}`
    : '';
  return new Error(`Batch export publication failed: ${messageFor(primary)}.${recovery}`);
}

export async function publishExportSet(
  entries: readonly ExportPublicationEntry[],
  overwrite: boolean,
  dependencies: ExportPublicationDependencies = {},
): Promise<string[]> {
  if (!entries.length) throw new ExportPublicationRefusalError('Batch export produced no publication members.');
  const fileSystem = dependencies.fileSystem ?? defaultFileSystem;
  const destinations = entries.map((entry) => resolve(entry.path));
  const parentDirectory = dirname(destinations[0]);
  const parentIdentity = portablePathIdentity(parentDirectory);
  const identities = new Set<string>();
  for (const destination of destinations) {
    if (portablePathIdentity(dirname(destination)) !== parentIdentity) {
      throw new ExportPublicationRefusalError('Every batch export companion must resolve beside its primary output.');
    }
    const identity = portablePathIdentity(destination);
    if (identities.has(identity)) {
      throw new ExportPublicationRefusalError(`Batch export members resolve to the same destination: ${destination}.`);
    }
    identities.add(identity);
  }

  const predecessors: Array<PredecessorSnapshot | undefined> = [];
  for (const destination of destinations) predecessors.push(await predecessorSnapshot(fileSystem, destination, overwrite));
  const predecessorIdentities = new Set<string>();
  for (const predecessor of predecessors) {
    if (!predecessor || predecessor.ino === 0) continue;
    const identity = `${predecessor.dev}:${predecessor.ino}`;
    if (predecessorIdentities.has(identity)) {
      throw new ExportPublicationRefusalError('Batch export destinations resolve to the same existing filesystem object.');
    }
    predecessorIdentities.add(identity);
  }

  await fileSystem.mkdir(parentDirectory, { recursive: true });
  const rawTransactionId = (dependencies.transactionId ?? randomUUID)();
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(rawTransactionId)) throw new Error('Batch export transaction ID is invalid.');
  const transactionDirectory = join(parentDirectory, `.aidraw-export-${rawTransactionId}`);
  await fileSystem.mkdir(transactionDirectory, { mode: 0o700 });
  const members: PublicationMember[] = entries.map((entry, index) => ({
    destination: destinations[index],
    data: entry.data,
    predecessor: predecessors[index],
    stagedPath: join(transactionDirectory, `${index}.tmp`),
    backupPath: join(transactionDirectory, `${index}.bak`),
    rollbackPath: join(transactionDirectory, `${index}.rollback`),
    state: 'untouched',
    backupPresent: false,
  }));
  let publicationBegan = false;
  try {
    for (const member of members) await fileSystem.writeFile(member.stagedPath, member.data, { flag: 'wx' });
    for (const member of members) {
      if (!await destinationStillMatches(fileSystem, member.destination, member.predecessor)) {
        throw new ExportPublicationRefusalError(`Output changed during batch export admission: ${member.destination}.`);
      }
    }
    for (const member of members) {
      if (!member.predecessor) continue;
      await fileSystem.link(member.destination, member.backupPath);
      member.state = 'backed-up';
      member.backupPresent = true;
      if (!(await fileSystem.readFile(member.backupPath)).equals(member.predecessor.bytes)) {
        throw new ExportPublicationRefusalError(`Output changed while batch publication began: ${member.destination}.`);
      }
    }
    for (const member of members) {
      if (member.predecessor) {
        if (!await destinationStillMatches(fileSystem, member.destination, member.predecessor)) {
          throw new ExportPublicationRefusalError(`Output changed before batch publication: ${member.destination}.`);
        }
        await fileSystem.rename(member.stagedPath, member.destination);
        member.state = 'published';
        publicationBegan = true;
      } else {
        try {
          await fileSystem.link(member.stagedPath, member.destination);
        } catch (error) {
          if (isAlreadyPresent(error)) {
            throw new ExportPublicationRefusalError(`Output appeared during batch publication: ${member.destination}.`);
          }
          throw error;
        }
        member.state = 'published';
        publicationBegan = true;
        await fileSystem.unlink(member.stagedPath);
      }
    }
    for (const member of members) {
      if (!member.backupPresent) continue;
      await fileSystem.unlink(member.backupPath);
      member.backupPresent = false;
    }
    await fileSystem.rmdir(transactionDirectory);
    return destinations;
  } catch (error) {
    const recoveryErrors = publicationBegan
      ? await rollbackPublication(fileSystem, transactionDirectory, members)
      : await cleanUnpublishedTransaction(fileSystem, transactionDirectory, members);
    if (!publicationBegan && error instanceof ExportPublicationRefusalError && !recoveryErrors.length) throw error;
    throw publicationFailure(error, recoveryErrors);
  }
}
