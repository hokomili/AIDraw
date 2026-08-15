import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  assignShortcut,
  defaultShortcutPreferences,
  shortcutAction,
  shortcutChordFromEvent,
  shortcutChordLabel,
  type ShortcutActionId,
  type ShortcutPreferences,
} from '../../common/shortcut-preferences';
import { EditorDialog } from './EditorDialog';
import {
  filterShortcutSections,
  shortcutSections,
  type ShortcutMode,
} from '../shortcuts';

interface ShortcutFeedback {
  tone: 'status' | 'error';
  message: string;
}

export function ShortcutReferenceDialog({
  mode,
  preferences,
  onChange,
  onClose,
}: {
  mode: ShortcutMode;
  preferences: ShortcutPreferences;
  onChange: (preferences: ShortcutPreferences) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [editingActionId, setEditingActionId] = useState<ShortcutActionId>();
  const [feedback, setFeedback] = useState<ShortcutFeedback>();
  const sections = useMemo(() => shortcutSections(mode, preferences), [mode, preferences]);
  const visibleSections = useMemo(() => filterShortcutSections(sections, query), [query, sections]);
  const resultCount = visibleSections.reduce((total, section) => total + section.entries.length, 0);

  const capture = (event: ReactKeyboardEvent<HTMLButtonElement>, actionId: ShortcutActionId) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setEditingActionId(undefined);
      setFeedback({ tone: 'status', message: `Kept ${shortcutAction(actionId).label} unchanged.` });
      return;
    }
    const captured = shortcutChordFromEvent(event.nativeEvent, actionId);
    if (!captured.captured) {
      setFeedback({ tone: 'error', message: captured.reason });
      return;
    }
    const assigned = assignShortcut(preferences, actionId, captured.chord);
    if (!assigned.accepted) {
      setFeedback({ tone: 'error', message: assigned.reason });
      return;
    }
    onChange(assigned.preferences);
    setEditingActionId(undefined);
    setFeedback({
      tone: 'status',
      message: `${shortcutAction(actionId).label} now uses ${shortcutChordLabel(captured.chord)}.`,
    });
  };

  const reset = () => {
    onChange(defaultShortcutPreferences());
    setEditingActionId(undefined);
    setFeedback({ tone: 'status', message: 'Restored the complete eligible shortcut mapping to defaults.' });
  };

  return (
    <EditorDialog
      title="Keyboard shortcuts"
      description={`Search the active shortcuts in the current ${mode} workspace. Eligible tool bindings and the inspector toggle can be changed; native-menu and focus/navigation commands remain fixed.`}
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
            placeholder="Try inspector, selection, or brush"
          />
        </label>
        <p className="shortcut-reference-note">
          Press F1 or ? to open this guide. Choose an editable binding, then press its replacement chord; Escape cancels capture. File, history, clipboard, and Select All remain fixed through Electron's native menu and existing renderer handlers; Ctrl/Cmd+Shift+Z is the renderer-owned redo alias.
        </p>
        {feedback && (
          <p
            id="shortcut-assignment-feedback"
            className={`shortcut-assignment-feedback is-${feedback.tone}`}
            role={feedback.tone === 'error' ? 'alert' : 'status'}
          >
            {feedback.message}
          </p>
        )}
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
                    <dt>
                      {entry.label}
                      {entry.fixedReason && <small>{entry.fixedReason}</small>}
                    </dt>
                    <dd>
                      {entry.actionId ? (
                        <button
                          type="button"
                          className={`shortcut-binding-button${editingActionId === entry.actionId ? ' is-capturing' : ''}`}
                          aria-label={editingActionId === entry.actionId
                            ? `Press a new shortcut for ${entry.label}; Escape cancels`
                            : `Change ${entry.label} shortcut, currently ${entry.keys[0]}`}
                          aria-describedby={feedback ? 'shortcut-assignment-feedback' : undefined}
                          onClick={() => {
                            setEditingActionId(entry.actionId);
                            setFeedback({ tone: 'status', message: `Press a new shortcut for ${entry.label}, or Escape to cancel.` });
                          }}
                          onKeyDown={editingActionId === entry.actionId
                            ? (event) => capture(event, entry.actionId!)
                            : undefined}
                        >
                          {editingActionId === entry.actionId ? <span>Press keys…</span> : <kbd>{entry.keys[0]}</kbd>}
                        </button>
                      ) : entry.keys.map((key) => <kbd key={key}>{key}</kbd>)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {resultCount === 0 && <p className="shortcut-empty">No shortcut matches “{query}”.</p>}
        </div>
      </div>
      <footer className="modal-footer">
        <button type="button" className="secondary-modal-button" onClick={reset}>Restore shortcut defaults</button>
        <button type="button" className="primary-modal-button" onClick={onClose}>Close</button>
      </footer>
    </EditorDialog>
  );
}
