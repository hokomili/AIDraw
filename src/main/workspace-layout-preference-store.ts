import {
  DEFAULT_WORKSPACE_LAYOUT_PREFERENCES,
  parseWorkspaceLayoutPreferences,
  type WorkspaceLayoutPreferences,
} from '../common/workspace-layout';
import { readBoundedRegularFile } from './bounded-file-read';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';

export const MAX_WORKSPACE_LAYOUT_PREFERENCE_FILE_BYTES = 2_048;
export const INVALID_WORKSPACE_LAYOUT_PREFERENCE_WARNING = 'Workspace layout preferences were invalid and were ignored; the default workspace layout is active. Change the workspace layout to replace the invalid local file.';

interface PersistedWorkspaceLayoutPreferencesV2 {
  version: 2;
  preferences: WorkspaceLayoutPreferences;
}

const PERSISTED_WORKSPACE_LAYOUT_PREFERENCE_KEYS = new Set(['version', 'preferences']);

export interface WorkspaceLayoutPreferenceStoreOptions {
  /** Narrow deterministic seam for atomic replacement and ordering coverage. */
  replaceFile?: PrivateJsonFileReplacer;
}

export interface WorkspaceLayoutPreferenceBootstrap {
  preferences: WorkspaceLayoutPreferences;
  warning?: string;
}

function defaults(): WorkspaceLayoutPreferences {
  return { ...DEFAULT_WORKSPACE_LAYOUT_PREFERENCES };
}

function parseVersionOnePreferences(value: unknown): WorkspaceLayoutPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace layout preference file.');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== 2
    || !keys.includes('inspectorCollapsed')
    || !keys.includes('inspectorExpandedWidth')
    || typeof source.inspectorCollapsed !== 'boolean'
    || !Number.isInteger(source.inspectorExpandedWidth)) {
    throw new Error('Invalid workspace layout preference file.');
  }
  return parseWorkspaceLayoutPreferences({
    inspectorCollapsed: source.inspectorCollapsed,
    inspectorExpandedWidth: source.inspectorExpandedWidth,
    mapSetupExpanded: DEFAULT_WORKSPACE_LAYOUT_PREFERENCES.mapSetupExpanded,
  });
}

function parsePersisted(value: unknown): WorkspaceLayoutPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace layout preference file.');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== PERSISTED_WORKSPACE_LAYOUT_PREFERENCE_KEYS.size
    || keys.some((key) => !PERSISTED_WORKSPACE_LAYOUT_PREFERENCE_KEYS.has(key))) {
    throw new Error('Invalid workspace layout preference file.');
  }
  if (source.version === 1) return parseVersionOnePreferences(source.preferences);
  if (source.version === 2) return parseWorkspaceLayoutPreferences(source.preferences);
  throw new Error('Invalid workspace layout preference file.');
}

/** Main-owned process-serial persistence for human-local editor layout preferences. */
export class WorkspaceLayoutPreferenceStore {
  private preferences = defaults();
  private loaded = false;
  private pendingWarning?: string;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly options: WorkspaceLayoutPreferenceStoreOptions = {},
  ) {}

  initialize(): Promise<void> {
    return this.exclusive(() => this.loadOnce());
  }

  bootstrap(): Promise<WorkspaceLayoutPreferenceBootstrap> {
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

  save(value: unknown): Promise<WorkspaceLayoutPreferences> {
    return this.exclusive(async () => {
      await this.loadOnce();
      const preferences = parseWorkspaceLayoutPreferences(value);
      const persisted: PersistedWorkspaceLayoutPreferencesV2 = { version: 2, preferences };
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
        maxBytes: MAX_WORKSPACE_LAYOUT_PREFERENCE_FILE_BYTES,
        notFileMessage: 'Workspace layout preference path is not a regular file.',
        tooLargeMessage: 'Workspace layout preference file exceeds its safety limit.',
        changedMessage: 'Workspace layout preference file changed while it was being read.',
      });
      this.preferences = parsePersisted(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      this.preferences = defaults();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.pendingWarning = INVALID_WORKSPACE_LAYOUT_PREFERENCE_WARNING;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation, operation);
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
