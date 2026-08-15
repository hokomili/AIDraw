import { DEFAULT_SPRITE_SYMMETRY_PREFERENCES, parseSpriteSymmetryPreferences, type SpriteSymmetryPreferences } from '../common/sprite-symmetry';
import { readBoundedRegularFile } from './bounded-file-read';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';

export const MAX_SPRITE_SYMMETRY_PREFERENCE_FILE_BYTES = 1_048_576;
export const INVALID_SPRITE_SYMMETRY_PREFERENCE_WARNING = 'Sprite symmetry preferences were invalid and were ignored; centered axes with symmetry off are active. Change a symmetry setting to replace the invalid local file.';

interface PersistedSpriteSymmetryPreferences {
  version: 1;
  preferences: SpriteSymmetryPreferences;
}

const PERSISTED_KEYS = new Set(['version', 'preferences']);

export interface SpriteSymmetryPreferenceStoreOptions {
  replaceFile?: PrivateJsonFileReplacer;
}

export interface SpriteSymmetryPreferenceBootstrap {
  preferences: SpriteSymmetryPreferences;
  warning?: string;
}

function defaults(): SpriteSymmetryPreferences {
  return { mode: DEFAULT_SPRITE_SYMMETRY_PREFERENCES.mode, bindings: [] };
}

function parsePersisted(value: unknown): SpriteSymmetryPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sprite symmetry preference file.');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== PERSISTED_KEYS.size || keys.some((key) => !PERSISTED_KEYS.has(key)) || source.version !== 1) {
    throw new Error('Invalid sprite symmetry preference file.');
  }
  return parseSpriteSymmetryPreferences(source.preferences);
}

/** Main-owned process-serial persistence for human-local sprite symmetry tool configuration. */
export class SpriteSymmetryPreferenceStore {
  private preferences = defaults();
  private loaded = false;
  private pendingWarning?: string;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly options: SpriteSymmetryPreferenceStoreOptions = {},
  ) {}

  initialize(): Promise<void> {
    return this.exclusive(() => this.loadOnce());
  }

  bootstrap(): Promise<SpriteSymmetryPreferenceBootstrap> {
    return this.exclusive(async () => {
      await this.loadOnce();
      const warning = this.pendingWarning;
      this.pendingWarning = undefined;
      return { preferences: structuredClone(this.preferences), ...(warning ? { warning } : {}) };
    });
  }

  save(value: unknown): Promise<SpriteSymmetryPreferences> {
    return this.exclusive(async () => {
      await this.loadOnce();
      const preferences = parseSpriteSymmetryPreferences(value);
      const persisted: PersistedSpriteSymmetryPreferences = { version: 1, preferences };
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
        maxBytes: MAX_SPRITE_SYMMETRY_PREFERENCE_FILE_BYTES,
        notFileMessage: 'Sprite symmetry preference path is not a regular file.',
        tooLargeMessage: 'Sprite symmetry preference file exceeds its safety limit.',
        changedMessage: 'Sprite symmetry preference file changed while it was being read.',
      });
      this.preferences = parsePersisted(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      this.preferences = defaults();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.pendingWarning = INVALID_SPRITE_SYMMETRY_PREFERENCE_WARNING;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation, operation);
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
