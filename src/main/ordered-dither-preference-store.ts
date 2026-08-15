import { DEFAULT_ORDERED_DITHER_PREFERENCES, parseOrderedDitherPreferences, type OrderedDitherPreferences } from '../common/ordered-dither-preferences';
import { readBoundedRegularFile } from './bounded-file-read';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';

export const MAX_ORDERED_DITHER_PREFERENCE_FILE_BYTES = 65_536;
export const INVALID_ORDERED_DITHER_PREFERENCE_WARNING = 'Ordered dither preferences were invalid and were ignored; the 4×4, 50%, phase 0,0 default with no presets is active. Change a dither setting to replace the invalid local file.';

interface PersistedOrderedDitherPreferences {
  version: 1;
  preferences: OrderedDitherPreferences;
}

const PERSISTED_KEYS = new Set(['version', 'preferences']);

export interface OrderedDitherPreferenceStoreOptions {
  replaceFile?: PrivateJsonFileReplacer;
}

export interface OrderedDitherPreferenceBootstrap {
  preferences: OrderedDitherPreferences;
  warning?: string;
}

function defaults(): OrderedDitherPreferences {
  return {
    current: { ...DEFAULT_ORDERED_DITHER_PREFERENCES.current },
    presets: [],
    activePresetId: null,
  };
}

function parsePersisted(value: unknown): OrderedDitherPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ordered dither preference file.');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== PERSISTED_KEYS.size || keys.some((key) => !PERSISTED_KEYS.has(key)) || source.version !== 1) {
    throw new Error('Invalid ordered dither preference file.');
  }
  return parseOrderedDitherPreferences(source.preferences);
}

/** Main-owned process-serial persistence for human-local ordered dither tool state. */
export class OrderedDitherPreferenceStore {
  private preferences = defaults();
  private loaded = false;
  private pendingWarning?: string;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly options: OrderedDitherPreferenceStoreOptions = {},
  ) {}

  initialize(): Promise<void> {
    return this.exclusive(() => this.loadOnce());
  }

  bootstrap(): Promise<OrderedDitherPreferenceBootstrap> {
    return this.exclusive(async () => {
      await this.loadOnce();
      const warning = this.pendingWarning;
      this.pendingWarning = undefined;
      return { preferences: structuredClone(this.preferences), ...(warning ? { warning } : {}) };
    });
  }

  save(value: unknown): Promise<OrderedDitherPreferences> {
    return this.exclusive(async () => {
      await this.loadOnce();
      const preferences = parseOrderedDitherPreferences(value);
      const persisted: PersistedOrderedDitherPreferences = { version: 1, preferences };
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
        maxBytes: MAX_ORDERED_DITHER_PREFERENCE_FILE_BYTES,
        notFileMessage: 'Ordered dither preference path is not a regular file.',
        tooLargeMessage: 'Ordered dither preference file exceeds its safety limit.',
        changedMessage: 'Ordered dither preference file changed while it was being read.',
      });
      this.preferences = parsePersisted(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      this.preferences = defaults();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.pendingWarning = INVALID_ORDERED_DITHER_PREFERENCE_WARNING;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation, operation);
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
