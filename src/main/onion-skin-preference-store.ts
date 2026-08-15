import { parseOnionSkinPreferences, DEFAULT_ONION_SKIN_PREFERENCES, type OnionSkinPreferences } from '../common/onion-skin';
import { readBoundedRegularFile } from './bounded-file-read';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';

export const MAX_ONION_SKIN_PREFERENCE_FILE_BYTES = 4_096;
export const INVALID_ONION_SKIN_PREFERENCE_WARNING = 'Onion skin preferences were invalid and were ignored; safe defaults are active. Change an onion setting to replace the invalid local file.';

interface PersistedOnionSkinPreferences {
  version: 1;
  preferences: OnionSkinPreferences;
}

const PERSISTED_ONION_SKIN_PREFERENCE_KEYS = new Set(['version', 'preferences']);

export interface OnionSkinPreferenceStoreOptions {
  /** Narrow deterministic seam for atomic replacement and ordering coverage. */
  replaceFile?: PrivateJsonFileReplacer;
}

export interface OnionSkinPreferenceBootstrap {
  preferences: OnionSkinPreferences;
  warning?: string;
}

function defaults(): OnionSkinPreferences {
  return { ...DEFAULT_ONION_SKIN_PREFERENCES };
}

function parsePersisted(value: unknown): OnionSkinPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid onion skin preference file.');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== PERSISTED_ONION_SKIN_PREFERENCE_KEYS.size
    || keys.some((key) => !PERSISTED_ONION_SKIN_PREFERENCE_KEYS.has(key))
    || source.version !== 1) {
    throw new Error('Invalid onion skin preference file.');
  }
  return parseOnionSkinPreferences(source.preferences);
}

/** Main-owned process-serial persistence for human-local onion preview preferences. */
export class OnionSkinPreferenceStore {
  private preferences = defaults();
  private loaded = false;
  private pendingWarning?: string;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly options: OnionSkinPreferenceStoreOptions = {},
  ) {}

  initialize(): Promise<void> {
    return this.exclusive(() => this.loadOnce());
  }

  bootstrap(): Promise<OnionSkinPreferenceBootstrap> {
    return this.exclusive(async () => {
      await this.loadOnce();
      const warning = this.pendingWarning;
      this.pendingWarning = undefined;
      return {
        preferences: structuredClone(this.preferences),
        ...(warning ? { warning } : {}),
      };
    });
  }

  save(value: unknown): Promise<OnionSkinPreferences> {
    return this.exclusive(async () => {
      await this.loadOnce();
      const preferences = parseOnionSkinPreferences(value);
      const persisted: PersistedOnionSkinPreferences = { version: 1, preferences };
      await replacePrivateJsonFile(this.filePath, persisted, this.options.replaceFile);
      this.preferences = preferences;
      return structuredClone(preferences);
    });
  }

  async flush(): Promise<void> {
    await this.requestQueue;
  }

  private async loadOnce(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const bytes = await readBoundedRegularFile(this.filePath, {
        maxBytes: MAX_ONION_SKIN_PREFERENCE_FILE_BYTES,
        notFileMessage: 'Onion skin preference path is not a regular file.',
        tooLargeMessage: 'Onion skin preference file exceeds its safety limit.',
        changedMessage: 'Onion skin preference file changed while it was being read.',
      });
      this.preferences = parsePersisted(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      this.preferences = defaults();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.pendingWarning = INVALID_ONION_SKIN_PREFERENCE_WARNING;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation, operation);
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
