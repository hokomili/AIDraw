import { useState } from 'react';
import type { IllustrationDocument } from '@aidraw/core';
import {
  MAX_BRUSH_LIBRARY_BYTES,
  parseBrushLibraryJson,
  prepareBrushLibraryImport,
  serializeBrushLibrary,
  type BrushLibraryImportMode,
  type BrushLibraryImportPlan,
} from '../../common/brush-library-interchange';
import { EditorDialog } from './EditorDialog';

interface BrushLibraryDialogProps {
  document: IllustrationDocument;
  onApply(plan: BrushLibraryImportPlan): Promise<boolean>;
  onClose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function BrushLibraryDialog({ document, onApply, onClose }: BrushLibraryDialogProps) {
  const currentCount = document.brushPresets.length;
  const [json, setJson] = useState('');
  const [mode, setMode] = useState<BrushLibraryImportMode>('append');
  const [plan, setPlan] = useState<BrushLibraryImportPlan>();
  const [previewRevision, setPreviewRevision] = useState<number>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const clearPreview = () => {
    setPlan(undefined);
    setPreviewRevision(undefined);
    setError(undefined);
    setNotice(undefined);
  };
  const changeJson = (value: string) => {
    setJson(value);
    clearPreview();
  };
  const changeMode = (value: BrushLibraryImportMode) => {
    setMode(value);
    clearPreview();
  };
  const buildPlan = (): BrushLibraryImportPlan => prepareBrushLibraryImport(document, parseBrushLibraryJson(json), mode);
  const preview = () => {
    setError(undefined);
    setNotice(undefined);
    try { setPlan(buildPlan()); setPreviewRevision(document.revision); } catch (caught) { setPlan(undefined); setPreviewRevision(undefined); setError(errorMessage(caught)); }
  };
  const copyCurrent = async () => {
    setError(undefined);
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(serializeBrushLibrary(document));
      setNotice(`Copied ${currentCount} custom brush preset${currentCount === 1 ? '' : 's'} as AIDraw JSON.`);
    } catch (caught) { setError(errorMessage(caught)); }
  };
  const loadFile = async (file: File) => {
    setError(undefined);
    setNotice(undefined);
    try {
      if (file.size > MAX_BRUSH_LIBRARY_BYTES) throw new Error('Brush library JSON is limited to 1 MiB.');
      changeJson(await file.text());
      setNotice(`Loaded ${file.name}. Preview before applying.`);
    } catch (caught) { setError(errorMessage(caught)); }
  };
  const applyPreview = async () => {
    if (!plan || previewRevision !== document.revision) return;
    setBusy(true);
    setError(undefined);
    try {
      const currentPlan = buildPlan();
      if (await onApply(currentPlan)) onClose();
      else setError('The brush library transaction was not applied.');
    } catch (caught) { setPlan(undefined); setPreviewRevision(undefined); setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };
  const previewIsCurrent = Boolean(plan && previewRevision === document.revision);

  return <EditorDialog
    title="Custom brush library JSON"
    description="Copy or import the custom raster-brush recipes owned by this illustration. Parsing and preview do not change the document."
    className="library-interchange-dialog"
    onClose={onClose}
  >
    <div className="library-interchange-body">
      <section className="library-interchange-current">
        <span><strong>Current library</strong><small>{currentCount} custom brush preset{currentCount === 1 ? '' : 's'}</small></span>
        <button type="button" disabled={currentCount === 0 || busy} onClick={() => void copyCurrent()}>Copy current JSON</button>
      </section>
      <div className="library-interchange-boundary">
        <strong>Compatibility boundary</strong>
        <p>Only document-owned custom recipes transfer. Built-ins, strokes, tip images, folders/tags, and application-wide libraries are not included. Existing strokes keep their embedded recipes when this library is replaced.</p>
      </div>
      <label className="dialog-field library-interchange-json"><span>Paste or load AIDraw brush-library JSON</span><textarea autoFocus rows={10} maxLength={MAX_BRUSH_LIBRARY_BYTES} spellCheck={false} value={json} onChange={(event) => changeJson(event.target.value)} placeholder='{"format":"aidraw-brush-library","version":1,…}' /></label>
      <div className="library-interchange-actions"><label className="library-interchange-file">Load JSON file<input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void loadFile(file); }} /></label><small>1 MiB · 256 custom presets · exact validated dab recipes</small></div>
      <fieldset className="library-interchange-modes"><legend>Import behavior</legend>
        <label><input type="radio" name="brush-library-mode" checked={mode === 'append'} onChange={() => changeMode('append')} /><span><strong>Add copies</strong><small>Keep this library; imported presets receive fresh IDs and unique names.</small></span></label>
        <label><input type="radio" name="brush-library-mode" checked={mode === 'replace'} onChange={() => changeMode('replace')} /><span><strong>Replace library</strong><small>Remove the current custom presets and preserve the imported library IDs.</small></span></label>
      </fieldset>
      {plan && previewIsCurrent && <div className="library-interchange-summary" role="status"><strong>Preview ready</strong><span>{plan.incomingCount} incoming → {plan.totalCount} total custom preset{plan.totalCount === 1 ? '' : 's'}</span><small>No document operation has run yet.</small></div>}
      {plan && !previewIsCurrent && <p className="entry-dialog-error" role="status">The document changed after preview. Preview again before applying.</p>}
      {notice && <p className="library-interchange-notice" role="status">{notice}</p>}
      {error && <p className="entry-dialog-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer library-interchange-footer"><button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button><button type="button" disabled={busy || !json.trim()} onClick={preview}>Preview import</button><button type="button" className="primary-modal-button" disabled={busy || !previewIsCurrent} onClick={() => void applyPreview()}>{busy ? 'Applying…' : mode === 'replace' ? 'Replace library' : 'Add copies'}</button></footer>
  </EditorDialog>;
}
