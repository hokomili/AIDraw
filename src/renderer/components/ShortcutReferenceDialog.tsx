import { useMemo, useState } from 'react';
import { EditorDialog } from './EditorDialog';
import {
  filterShortcutSections,
  shortcutSections,
  type ShortcutMode,
  type ShortcutTool,
} from '../shortcuts';

export function ShortcutReferenceDialog({
  mode,
  tools,
  onClose,
}: {
  mode: ShortcutMode;
  tools: ShortcutTool[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const sections = useMemo(() => shortcutSections(mode, tools), [mode, tools]);
  const visibleSections = useMemo(() => filterShortcutSections(sections, query), [query, sections]);
  const resultCount = visibleSections.reduce((total, section) => total + section.entries.length, 0);

  return (
    <EditorDialog
      title="Keyboard shortcuts"
      description={`Search the fixed shortcuts available in the current ${mode} workspace. Tool keys are ignored while typing in a field.`}
      className="shortcut-reference-dialog"
      onClose={onClose}
    >
      <div className="shortcut-reference-body">
        <label className="shortcut-search">
          <span>Find a command or key</span>
          <input
            autoFocus
            type="search"
            maxLength={100}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Try save, selection, or brush"
          />
        </label>
        <p className="shortcut-reference-note">
          Press F1 or ? to open this guide. Tab reveals a Skip to canvas control. Shortcuts are documented here, not remappable in this checkpoint.
        </p>
        <div className="shortcut-result-summary" role="status" aria-live="polite">
          {resultCount} command{resultCount === 1 ? '' : 's'}
        </div>
        <div className="shortcut-section-list">
          {visibleSections.map((section) => (
            <section key={section.id} className="shortcut-section">
              <h3>{section.title}</h3>
              <dl>
                {section.entries.map((entry) => (
                  <div key={entry.id} className="shortcut-row">
                    <dt>{entry.label}</dt>
                    <dd>{entry.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {resultCount === 0 && <p className="shortcut-empty">No shortcut matches “{query}”.</p>}
        </div>
      </div>
      <footer className="modal-footer">
        <button type="button" className="primary-modal-button" onClick={onClose}>Close</button>
      </footer>
    </EditorDialog>
  );
}
