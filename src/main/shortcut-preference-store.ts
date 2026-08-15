import {
  defaultShortcutPreferences,
  migrateShortcutPreferencesV1,
  parseShortcutPreferences,
  type ShortcutPreferences,
} from '../common/shortcut-preferences';
import { readBoundedRegularFile } from './bounded-file-read';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';

export const MAX_SHORTCUT_PREFERENCE_FILE_BYTES = 16_384;
export const INVALID_SHORTCUT_PREFERENCE_WARNING = 'Keyboard shortcut preferences were invalid and were ignored; the complete default mapping is active. Change a shortcut or restore defaults to replace the invalid local file.';

interface PersistedShortcutPreferences {
  version: 2;
  preferences: ShortcutPreferences;
}

const PERSISTED_KEYS = new Set(['version', 'preferences']);

export interface ShortcutPreferenceStoreOptions {
  /** Narrow deterministic seam for atomic replacement and ordering coverage. */
  replaceFile?: PrivateJsonFileReplacer;
}

export interface ShortcutPreferenceBootstrap {
  preferences: ShortcutPreferences;
  warning?: string;
}

function parsePersisted(value: unknown): ShortcutPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid shortcut preference file.');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== PERSISTED_KEYS.size || keys.some((key) => !PERSISTED_KEYS.has(key))) {
    throw new Error('Invalid shortcut preference file.');
  }
  if (source.version === 2) return parseShortcutPreferences(source.preferences);
  if (source.version === 1) return migrateShortcutPreferencesV1(source.preferences);
  throw new Error('Invalid shortcut preference file.');
}

/** Main-owned process-serial persistence for the complete human shortcut map. */
export class ShortcutPreferenceStore {
  private preferences = defaultShortcutPreferences();
  private loaded = false;
  private pendingWarning?: string;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly options: ShortcutPreferenceStoreOptions = {},
  ) {}

  initialize(): Promise<void> {
    return this.exclusive(() => this.loadOnce());
  }

  bootstrap(): Promise<ShortcutPreferenceBootstrap> {
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

  save(value: unknown): Promise<ShortcutPreferences> {
    return this.exclusive(async () => {
      await this.loadOnce();
      const preferences = parseShortcutPreferences(value);
      const persisted: PersistedShortcutPreferences = { version: 2, preferences };
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
        maxBytes: MAX_SHORTCUT_PREFERENCE_FILE_BYTES,
        notFileMessage: 'Shortcut preference path is not a regular file.',
        tooLargeMessage: 'Shortcut preference file exceeds its safety limit.',
        changedMessage: 'Shortcut preference file changed while it was being read.',
      });
      this.preferences = parsePersisted(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      this.preferences = defaultShortcutPreferences();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.pendingWarning = INVALID_SHORTCUT_PREFERENCE_WARNING;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation, operation);
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
