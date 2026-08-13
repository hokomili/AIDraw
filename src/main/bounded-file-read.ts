import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';

export interface BoundedFileReadOptions {
  maxBytes: number;
  minBytes?: number;
  notFileMessage: string;
  tooLargeMessage: string;
  tooSmallMessage?: string;
  changedMessage: string;
}

export interface BoundedFileHandle {
  stat(): Promise<BoundedFileStat>;
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export type BoundedFileOpener = (filePath: string) => Promise<BoundedFileHandle>;
export interface BoundedFileStat { isFile(): boolean; size: number }
export type BoundedFileInspector = (filePath: string) => Promise<BoundedFileStat>;

const openBoundedFile: BoundedFileOpener = async (filePath) => open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
const inspectBoundedFile: BoundedFileInspector = stat;

function assertFileDetails(details: BoundedFileStat, options: BoundedFileReadOptions, minimum: number): void {
  if (!details.isFile()) throw new Error(options.notFileMessage);
  if (!Number.isSafeInteger(details.size) || details.size > options.maxBytes) throw new Error(options.tooLargeMessage);
  if (details.size < minimum) throw new Error(options.tooSmallMessage ?? options.changedMessage);
}

/**
 * Read one approved regular file without allowing post-stat growth to turn the
 * declared ceiling into an unrestricted read. The extra byte exists only to
 * detect growth; it is never returned to a caller.
 */
export async function readBoundedRegularFile(
  filePath: string,
  options: BoundedFileReadOptions,
  openFile: BoundedFileOpener = openBoundedFile,
  inspectFile: BoundedFileInspector = inspectBoundedFile,
): Promise<Buffer> {
  const minimum = options.minBytes ?? 0;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1
    || !Number.isSafeInteger(minimum) || minimum < 0 || minimum > options.maxBytes) {
    throw new Error('Bounded file read requires valid byte limits.');
  }

  assertFileDetails(await inspectFile(filePath), options, minimum);
  const handle = await openFile(filePath);
  let output: Buffer | undefined;
  let failure: unknown;
  try {
    const details = await handle.stat();
    assertFileDetails(details, options, minimum);

    const allocation = Buffer.allocUnsafe(details.size + 1);
    let offset = 0;
    while (offset < allocation.byteLength) {
      const requested = allocation.byteLength - offset;
      const { bytesRead } = await handle.read(allocation, offset, requested, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > requested) {
        throw new Error(options.changedMessage);
      }
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== details.size) throw new Error(options.changedMessage);
    output = allocation.subarray(0, offset);
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
  return output!;
}
