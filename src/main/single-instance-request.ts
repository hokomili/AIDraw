import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export type PersistentEngineRequest = 'show' | 'headless' | 'quit-engine';

export function persistentEngineTarget(userDataPath: string, platform = process.platform): string {
  const normalized = platform === 'win32' ? resolve(userDataPath).toLowerCase() : resolve(userDataPath);
  return createHash('sha256').update(normalized).digest('hex');
}

/** Accept only a command explicitly addressed to this profile's singleton. */
export function targetedPersistentEngineRequest(
  additionalData: unknown,
  expectedTarget: string,
): PersistentEngineRequest | undefined {
  if (!additionalData || typeof additionalData !== 'object') return undefined;
  const data = additionalData as { command?: unknown; target?: unknown };
  if (data.target !== expectedTarget) return undefined;
  return data.command === 'show' || data.command === 'headless' || data.command === 'quit-engine'
    ? data.command
    : undefined;
}
