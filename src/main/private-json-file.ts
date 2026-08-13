import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export type PrivateFileReplacer = (source: string, destination: string) => Promise<void>;
export type PrivateJsonFileReplacer = PrivateFileReplacer;

/** Flush complete private bytes before atomically replacing their same-directory destination. */
export async function replacePrivateFile(
  filePath: string,
  contents: string | Uint8Array,
  replaceFile: PrivateFileReplacer = rename,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    if (typeof contents === 'string') await handle.writeFile(contents, 'utf8');
    else await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await replaceFile(temporary, filePath);
  } catch (error) {
    try { await handle?.close(); } catch { /* Preserve the primary persistence failure. */ }
    try { await unlink(temporary); } catch { /* The temporary may not exist or may already be replaced. */ }
    throw error;
  }
}

export function replacePrivateTextFile(
  filePath: string,
  contents: string,
  replaceFile?: PrivateFileReplacer,
): Promise<void> {
  return replacePrivateFile(filePath, contents, replaceFile);
}

/** Flush a complete private JSON value before atomically replacing its same-directory destination. */
export async function replacePrivateJsonFile(
  filePath: string,
  value: unknown,
  replaceFile: PrivateJsonFileReplacer = rename,
): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await replacePrivateTextFile(filePath, contents, replaceFile);
}
