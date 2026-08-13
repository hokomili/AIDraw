export type ShortcutMode = 'illustration' | 'pixel';

export interface ShortcutTool {
  id: string;
  label: string;
  shortcut: string;
}

export interface ShortcutEntry {
  id: string;
  label: string;
  keys: string[];
  scope?: ShortcutMode;
}

export interface ShortcutSection {
  id: string;
  title: string;
  entries: ShortcutEntry[];
}

const fixedShortcutSections: ShortcutSection[] = [
  {
    id: 'file-history',
    title: 'File and history',
    entries: [
      { id: 'new-illustration', label: 'New illustration', keys: ['Ctrl/Cmd + N'] },
      { id: 'new-pixel', label: 'New pixel sprite', keys: ['Ctrl/Cmd + Shift + N'] },
      { id: 'open', label: 'Open document', keys: ['Ctrl/Cmd + O'] },
      { id: 'save', label: 'Save document', keys: ['Ctrl/Cmd + S'] },
      { id: 'save-as', label: 'Save as', keys: ['Ctrl/Cmd + Shift + S'] },
      { id: 'undo', label: 'Undo my action', keys: ['Ctrl/Cmd + Z'] },
      { id: 'redo', label: 'Redo my action', keys: ['Ctrl/Cmd + Shift + Z', 'Ctrl/Cmd + Y'] },
    ],
  },
  {
    id: 'selection',
    title: 'Selection and clipboard',
    entries: [
      { id: 'copy', label: 'Copy selection', keys: ['Ctrl/Cmd + C'] },
      { id: 'cut', label: 'Cut selection', keys: ['Ctrl/Cmd + X'] },
      { id: 'paste', label: 'Paste', keys: ['Ctrl/Cmd + V'] },
      { id: 'delete', label: 'Delete selection', keys: ['Delete', 'Backspace'] },
      { id: 'edit-text', label: 'Edit selected illustration text', keys: ['Enter'], scope: 'illustration' },
      { id: 'select-all-pixels', label: 'Select all finite pixel cells', keys: ['Ctrl/Cmd + A'], scope: 'pixel' },
      { id: 'clear-pixels', label: 'Clear pixel selection or cancel a canvas gesture', keys: ['Escape'], scope: 'pixel' },
    ],
  },
  {
    id: 'navigation',
    title: 'Keyboard navigation',
    entries: [
      { id: 'shortcut-guide', label: 'Open this shortcut guide', keys: ['F1', '?'] },
      { id: 'document-tabs', label: 'Move through focused document tabs', keys: ['Arrow Left / Right', 'Home / End'] },
      { id: 'all-documents-menu', label: 'Move through the open All documents menu', keys: ['Arrow Up / Down', 'Home / End'] },
      { id: 'tool-rail', label: 'Move through the focused tool rail', keys: ['Arrow Up / Down', 'Home / End'] },
      { id: 'inspector-tabs', label: 'Move through focused inspector tabs', keys: ['Arrow Left / Right', 'Home / End'] },
      { id: 'skip-canvas', label: 'Use the focus-visible Skip to canvas control', keys: ['Tab', 'Enter'] },
    ],
  },
];

export function shortcutSections(mode: ShortcutMode, tools: ShortcutTool[]): ShortcutSection[] {
  const sections = fixedShortcutSections.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) => !entry.scope || entry.scope === mode),
  }));
  const toolEntries = tools.map((tool) => ({
    id: `tool:${mode}:${tool.id}`,
    label: tool.label,
    keys: [tool.shortcut],
  }));
  if (toolEntries.length) sections.push({
    id: 'tools',
    title: mode === 'illustration' ? 'Illustration tools' : 'Pixel tools',
    entries: toolEntries,
  });
  return sections;
}

export function filterShortcutSections(sections: ShortcutSection[], rawQuery: string): ShortcutSection[] {
  const terms = rawQuery.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return sections;
  return sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => {
        const searchable = `${section.title} ${entry.label} ${entry.keys.join(' ')}`.toLowerCase();
        return terms.every((term) => searchable.includes(term));
      }),
    }))
    .filter((section) => section.entries.length > 0);
}

export function shortcutHelpRequested(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.key === 'F1' || event.key === '?';
}

export function toolRailFocusIndex(key: string, currentIndex: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return currentIndex < 0 ? 0 : (currentIndex + 1) % count;
  if (key === 'ArrowUp') return currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count;
  return undefined;
}
