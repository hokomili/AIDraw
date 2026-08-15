export type ShortcutMode = 'illustration' | 'pixel';
export type ShortcutActionKind = 'application' | 'tool';
export type ShortcutActionScope = 'global' | ShortcutMode;
export type ShortcutSectionId = 'file-history' | 'selection' | 'navigation' | 'tools';

interface ShortcutActionShape {
  id: string;
  label: string;
  kind: ShortcutActionKind;
  scope: ShortcutActionScope;
  section: ShortcutSectionId;
  defaultChord: string;
  toolId?: string;
}

/**
 * The bounded remappable surface. Fixed focus/navigation commands deliberately
 * stay outside this registry so the guide and editor always retain a recovery
 * route even when a user changes every admitted binding.
 */
export const SHORTCUT_ACTIONS = [
  { id: 'toggle-inspector', label: 'Open or collapse the inspector sidebar', kind: 'application', scope: 'global', section: 'navigation', defaultChord: 'Primary+Shift+I' },

  { id: 'tool:illustration:select', label: 'Select', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'V', toolId: 'select' },
  { id: 'tool:illustration:lasso', label: 'Lasso', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'L', toolId: 'lasso' },
  { id: 'tool:illustration:hand', label: 'Pan', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'H', toolId: 'hand' },
  { id: 'tool:illustration:zoom', label: 'Zoom', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'Z', toolId: 'zoom' },
  { id: 'tool:illustration:pen', label: 'Pressure pen', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'P', toolId: 'pen' },
  { id: 'tool:illustration:pencil', label: 'Vector pencil', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'N', toolId: 'pencil' },
  { id: 'tool:illustration:bezier', label: 'Bézier path', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'A', toolId: 'bezier' },
  { id: 'tool:illustration:brush', label: 'Raster brush', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'B', toolId: 'brush' },
  { id: 'tool:illustration:eraser', label: 'Eraser', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'E', toolId: 'eraser' },
  { id: 'tool:illustration:line', label: 'Line / arrow', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'Backslash', toolId: 'line' },
  { id: 'tool:illustration:rectangle', label: 'Rectangle', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'R', toolId: 'rectangle' },
  { id: 'tool:illustration:ellipse', label: 'Ellipse', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'O', toolId: 'ellipse' },
  { id: 'tool:illustration:text', label: 'Text', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'T', toolId: 'text' },
  { id: 'tool:illustration:eyedropper', label: 'Eyedropper', kind: 'tool', scope: 'illustration', section: 'tools', defaultChord: 'I', toolId: 'eyedropper' },

  { id: 'tool:pixel:select', label: 'Select', kind: 'tool', scope: 'pixel', section: 'tools', defaultChord: 'V', toolId: 'select' },
  { id: 'tool:pixel:lasso', label: 'Lasso', kind: 'tool', scope: 'pixel', section: 'tools', defaultChord: 'L', toolId: 'lasso' },
  { id: 'tool:pixel:hand', label: 'Pan', kind: 'tool', scope: 'pixel', section: 'tools', defaultChord: 'H', toolId: 'hand' },
  { id: 'tool:pixel:zoom', label: 'Zoom', kind: 'tool', scope: 'pixel', section: 'tools', defaultChord: 'Z', toolId: 'zoom' },
  { id: 'tool:pixel:pencil', label: 'Pixel-perfect pencil', kind: 'tool', scope: 'pixel', section: 'tools', defaultChord: 'B', toolId: 'pencil' },
  { id: 'tool:pixel:eraser', label: 'Eraser', kind: 'tool', scope: 'pixel', section: 'tools', defaultChord: 'E', toolId: 'eraser' },
  { id: 'tool:pixel:fill', label: 'Fill', kind: 'tool', scope: 'pixel', section: 'tools', defaultChord: 'G', toolId: 'fill' },
  { id: 'tool:pixel:wand', label: 'Magic wand', kind: 'tool', scope: 'pixel', section: 'tools', defaultChord: 'W', toolId: 'wand' },
  { id: 'tool:pixel:eyedropper', label: 'Palette picker', kind: 'tool', scope: 'pixel', section: 'tools', defaultChord: 'I', toolId: 'eyedropper' },
] as const satisfies readonly ShortcutActionShape[];

export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]['id'];
export type ShortcutChord = string;

export interface ShortcutPreferences {
  bindings: Record<ShortcutActionId, ShortcutChord>;
}

export type ShortcutAssignmentResult =
  | { accepted: true; preferences: ShortcutPreferences }
  | { accepted: false; reason: string; conflictingActionId?: ShortcutActionId };

export type ShortcutCaptureResult =
  | { captured: true; chord: ShortcutChord }
  | { captured: false; reason: string };

const ACTIONS_BY_ID = new Map<ShortcutActionId, (typeof SHORTCUT_ACTIONS)[number]>(
  SHORTCUT_ACTIONS.map((action) => [action.id, action]),
);
const ACTION_IDS = new Set<string>(SHORTCUT_ACTIONS.map((action) => action.id));
const PREFERENCE_KEYS = new Set(['bindings']);
const RESERVED_APPLICATION_CHORDS = new Map<ShortcutChord, string>([
  ['Primary+N', 'Ctrl/Cmd+N is fixed by the native New menu command in this checkpoint.'],
  ['Primary+Shift+N', 'Ctrl/Cmd+Shift+N is fixed by the native New Pixel menu command in this checkpoint.'],
  ['Primary+O', 'Ctrl/Cmd+O is fixed by the native Open menu command in this checkpoint.'],
  ['Primary+Shift+O', 'Ctrl/Cmd+Shift+O overlaps the current fixed Open handler in this checkpoint.'],
  ['Primary+S', 'Ctrl/Cmd+S is fixed by the native Save menu command in this checkpoint.'],
  ['Primary+Shift+S', 'Ctrl/Cmd+Shift+S is fixed by the native Save As menu command in this checkpoint.'],
  ['Primary+Z', 'Ctrl/Cmd+Z is fixed by the native Undo menu command in this checkpoint.'],
  ['Primary+Shift+Z', 'Ctrl/Cmd+Shift+Z is the fixed renderer redo alias in this checkpoint.'],
  ['Primary+Y', 'Ctrl/Cmd+Y is fixed by the native Redo menu command in this checkpoint.'],
  ['Primary+Shift+Y', 'Ctrl/Cmd+Shift+Y overlaps the current fixed Redo handler in this checkpoint.'],
  ['Primary+C', 'Ctrl/Cmd+C is fixed by the native clipboard menu role in this checkpoint.'],
  ['Primary+Shift+C', 'Ctrl/Cmd+Shift+C overlaps the current fixed Copy handler in this checkpoint.'],
  ['Primary+X', 'Ctrl/Cmd+X is fixed by the native clipboard menu role in this checkpoint.'],
  ['Primary+Shift+X', 'Ctrl/Cmd+Shift+X overlaps the current fixed Cut handler in this checkpoint.'],
  ['Primary+V', 'Ctrl/Cmd+V is fixed by the native clipboard menu role in this checkpoint.'],
  ['Primary+Shift+V', 'Ctrl/Cmd+Shift+V overlaps the current fixed Paste handler in this checkpoint.'],
  ['Primary+A', 'Ctrl/Cmd+A is fixed by the native Select All menu role in this checkpoint.'],
  ['Primary+Shift+A', 'Ctrl/Cmd+Shift+A overlaps the current fixed pixel Select All handler in this checkpoint.'],
  ['Primary+Q', 'Ctrl/Cmd+Q is reserved for application quit.'],
  ['Primary+W', 'Ctrl/Cmd+W is reserved for window and document lifecycle behavior.'],
  ['Primary+M', 'Ctrl/Cmd+M is reserved for operating-system window behavior.'],
  ['Primary+H', 'Ctrl/Cmd+H is reserved for operating-system application visibility.'],
  ['Primary+R', 'Ctrl/Cmd+R is reserved for application recovery behavior.'],
  ['Primary+Shift+R', 'Ctrl/Cmd+Shift+R is reserved for application recovery behavior.'],
]);

export const DEFAULT_SHORTCUT_PREFERENCES: Readonly<ShortcutPreferences> = Object.freeze({
  bindings: Object.freeze(Object.fromEntries(
    SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultChord]),
  )) as Record<ShortcutActionId, ShortcutChord>,
});

function clonePreferences(preferences: ShortcutPreferences): ShortcutPreferences {
  return { bindings: { ...preferences.bindings } };
}

function exactObject(value: unknown, keys: Set<string>, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  const source = value as Record<string, unknown>;
  const actual = Object.keys(source);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) throw new Error(message);
  return source;
}

function canonicalChord(value: unknown): ShortcutChord {
  if (typeof value !== 'string') throw new Error('Invalid shortcut chord.');
  if (/^[A-Z]$/u.test(value) || value === 'Backslash') return value;
  if (/^Primary\+(?:Shift\+)?[A-Z]$/u.test(value)) return value;
  throw new Error('Invalid shortcut chord.');
}

function actionFor(id: ShortcutActionId): (typeof SHORTCUT_ACTIONS)[number] {
  const action = ACTIONS_BY_ID.get(id);
  if (!action) throw new Error('Unknown shortcut action.');
  return action;
}

function scopesOverlap(left: ShortcutActionScope, right: ShortcutActionScope): boolean {
  return left === 'global' || right === 'global' || left === right;
}

function chordAdmissionReason(actionId: ShortcutActionId, chord: ShortcutChord): string | undefined {
  const action = actionFor(actionId);
  if (action.kind === 'tool') {
    if (!(/^[A-Z]$/u.test(chord) || chord === 'Backslash')) {
      return 'Tool shortcuts must be one unmodified letter or Backslash.';
    }
    return undefined;
  }
  if (!/^Primary\+(?:Shift\+)?[A-Z]$/u.test(chord)) {
    return 'Application shortcuts must use Ctrl/Cmd plus one letter, with optional Shift.';
  }
  return RESERVED_APPLICATION_CHORDS.get(chord);
}

/** Strictly admit one complete, conflict-free human-local shortcut map. */
export function parseShortcutPreferences(value: unknown): ShortcutPreferences {
  const source = exactObject(value, PREFERENCE_KEYS, 'Invalid shortcut preferences.');
  const rawBindings = exactObject(source.bindings, ACTION_IDS, 'Invalid shortcut preferences.');
  const bindings = {} as Record<ShortcutActionId, ShortcutChord>;
  for (const action of SHORTCUT_ACTIONS) {
    const chord = canonicalChord(rawBindings[action.id]);
    if (chordAdmissionReason(action.id, chord)) throw new Error('Invalid shortcut preferences.');
    bindings[action.id] = chord;
  }
  for (let leftIndex = 0; leftIndex < SHORTCUT_ACTIONS.length; leftIndex += 1) {
    const left = SHORTCUT_ACTIONS[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < SHORTCUT_ACTIONS.length; rightIndex += 1) {
      const right = SHORTCUT_ACTIONS[rightIndex];
      if (scopesOverlap(left.scope, right.scope) && bindings[left.id] === bindings[right.id]) {
        throw new Error('Invalid shortcut preferences.');
      }
    }
  }
  return { bindings };
}

export function defaultShortcutPreferences(): ShortcutPreferences {
  return clonePreferences(DEFAULT_SHORTCUT_PREFERENCES);
}

export function shortcutAction(id: ShortcutActionId): (typeof SHORTCUT_ACTIONS)[number] {
  return actionFor(id);
}

export function shortcutActionsForMode(mode: ShortcutMode): ReadonlyArray<(typeof SHORTCUT_ACTIONS)[number]> {
  return SHORTCUT_ACTIONS.filter((action) => action.scope === 'global' || action.scope === mode);
}

export function shortcutActionIdForTool(mode: ShortcutMode, toolId: string): ShortcutActionId | undefined {
  return SHORTCUT_ACTIONS.find((action) => action.kind === 'tool' && action.scope === mode && action.toolId === toolId)?.id;
}

export function shortcutChordForAction(preferences: ShortcutPreferences, actionId: ShortcutActionId): ShortcutChord {
  return preferences.bindings[actionId];
}

export function shortcutChordLabel(chord: ShortcutChord): string {
  if (chord === 'Backslash') return '\\';
  return chord.replace('Primary', 'Ctrl/Cmd').replaceAll('+', ' + ');
}

export function shortcutAriaKeyShortcuts(chord: ShortcutChord): string {
  if (chord === 'Backslash') return '\\';
  if (!chord.startsWith('Primary+')) return chord;
  const suffix = chord.slice('Primary+'.length);
  return `Control+${suffix} Meta+${suffix}`;
}

type ShortcutKeyboardEvent = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

export function shortcutChordFromEvent(event: ShortcutKeyboardEvent, actionId: ShortcutActionId): ShortcutCaptureResult {
  const action = actionFor(actionId);
  if (event.altKey || (event.ctrlKey && event.metaKey)) {
    return { captured: false, reason: 'Alt and combined Ctrl+Cmd chords are not supported.' };
  }
  let key: ShortcutChord | undefined;
  if (event.key === '\\') key = 'Backslash';
  else if (/^[a-z]$/iu.test(event.key)) key = event.key.toUpperCase();
  if (!key) return { captured: false, reason: 'Use one letter key, or Backslash for a tool shortcut.' };
  const primary = event.ctrlKey || event.metaKey;
  const chord = primary ? `Primary+${event.shiftKey ? 'Shift+' : ''}${key}` : key;
  if (!primary && event.shiftKey) return { captured: false, reason: 'Shift-only shortcuts are not supported.' };
  const reason = chordAdmissionReason(action.id, chord);
  return reason ? { captured: false, reason } : { captured: true, chord };
}

export function assignShortcut(
  value: ShortcutPreferences,
  actionId: ShortcutActionId,
  chord: ShortcutChord,
): ShortcutAssignmentResult {
  const preferences = parseShortcutPreferences(value);
  const canonical = canonicalChord(chord);
  const reason = chordAdmissionReason(actionId, canonical);
  if (reason) return { accepted: false, reason };
  const action = actionFor(actionId);
  const conflict = SHORTCUT_ACTIONS.find((candidate) => candidate.id !== actionId
    && scopesOverlap(action.scope, candidate.scope)
    && preferences.bindings[candidate.id] === canonical);
  if (conflict) {
    return {
      accepted: false,
      reason: `${shortcutChordLabel(canonical)} is already assigned to ${conflict.label}.`,
      conflictingActionId: conflict.id,
    };
  }
  return {
    accepted: true,
    preferences: { bindings: { ...preferences.bindings, [actionId]: canonical } },
  };
}

export function shortcutEventMatchesChord(event: ShortcutKeyboardEvent, chord: ShortcutChord): boolean {
  if (event.altKey || (event.ctrlKey && event.metaKey)) return false;
  const primary = chord.startsWith('Primary+');
  if (primary !== (event.ctrlKey || event.metaKey)) return false;
  const requiresShift = chord.startsWith('Primary+Shift+');
  if (requiresShift !== event.shiftKey) return false;
  const expected = chord === 'Backslash' ? '\\' : chord.split('+').at(-1);
  return event.key.toUpperCase() === expected;
}

export function shortcutActionForEvent(
  preferences: ShortcutPreferences,
  event: ShortcutKeyboardEvent,
  mode: ShortcutMode,
  kind?: ShortcutActionKind,
): (typeof SHORTCUT_ACTIONS)[number] | undefined {
  return SHORTCUT_ACTIONS.find((action) => (action.scope === 'global' || action.scope === mode)
    && (!kind || action.kind === kind)
    && shortcutEventMatchesChord(event, preferences.bindings[action.id]));
}
