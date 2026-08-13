import { useState } from 'react';
import type { PixelDocument, PixelTilemap } from '@aidraw/core';
import {
  MAX_STAMP_LIBRARY_BYTES,
  parseStampLibraryJson,
  prepareStampLibraryImport,
  serializePixelStampLibrary,
  serializeTileStampLibrary,
  type StampLibraryImportMode,
  type StampLibraryImportPlan,
} from '../../common/stamp-library-interchange';
import { EditorDialog } from './EditorDialog';

interface StampLibraryDialogProps {
  document: PixelDocument;
  map?: PixelTilemap;
  onApply(plan: StampLibraryImportPlan): Promise<boolean>;
  onClose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function StampLibraryDialog({ document, map, onApply, onClose }: StampLibraryDialogProps) {
  const kind = map ? 'tile' : 'pixel';
  const currentCount = kind === 'tile' ? document.tileStamps.length : document.stamps.length;
  const [json, setJson] = useState('');
  const [mode, setMode] = useState<StampLibraryImportMode>('append');
  const [plan, setPlan] = useState<StampLibraryImportPlan>();
  const [previewRevision, setPreviewRevision] = useState<number>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const changeJson = (value: string) => {
    setJson(value);
    setPlan(undefined);
    setPreviewRevision(undefined);
    setError(undefined);
    setNotice(undefined);
  };
  const changeMode = (value: StampLibraryImportMode) => {
    setMode(value);
    setPlan(undefined);
    setPreviewRevision(undefined);
    setError(undefined);
    setNotice(undefined);
  };
  const buildPlan = (): StampLibraryImportPlan => {
    const bundle = parseStampLibraryJson(json);
    if (bundle.kind !== kind) throw new Error(`This ${kind} surface requires a ${kind} stamp library.`);
    return prepareStampLibraryImport(document, bundle, mode, { map });
  };
  const preview = () => {
    setError(undefined);
    setNotice(undefined);
    try { setPlan(buildPlan()); setPreviewRevision(document.revision); } catch (caught) { setPlan(undefined); setPreviewRevision(undefined); setError(errorMessage(caught)); }
  };
  const copyCurrent = async () => {
    setError(undefined);
    setNotice(undefined);
    try {
      const serialized = map ? serializeTileStampLibrary(document, map) : serializePixelStampLibrary(document);
      await navigator.clipboard.writeText(serialized);
      setNotice(`Copied ${currentCount} ${kind} stamp${currentCount === 1 ? '' : 's'} as AIDraw JSON.`);
    } catch (caught) { setError(errorMessage(caught)); }
  };
  const loadFile = async (file: File) => {
    setError(undefined);
    setNotice(undefined);
    try {
      if (file.size > MAX_STAMP_LIBRARY_BYTES) throw new Error('Stamp library JSON is limited to 16 MiB.');
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
      else setError('The stamp library transaction was not applied.');
    } catch (caught) { setPlan(undefined); setPreviewRevision(undefined); setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };
  const paletteOperation = plan?.operations.find((operation) => operation.kind === 'pixel.palette.replace');
  const addedColors = paletteOperation?.kind === 'pixel.palette.replace' ? paletteOperation.palette.length - document.palette.length : 0;
  const previewIsCurrent = Boolean(plan && previewRevision === document.revision);

  return <EditorDialog
    title={`${kind === 'pixel' ? 'Pixel' : 'Tile'} stamp library JSON`}
    description={`Copy or import the reusable ${kind} stamps owned by this document. Parsing and preview do not change the document.`}
    className="library-interchange-dialog"
    onClose={onClose}
  >
    <div className="library-interchange-body">
      <section className="library-interchange-current">
        <span><strong>Current library</strong><small>{currentCount} reusable {kind} stamp{currentCount === 1 ? '' : 's'}</small></span>
        <button type="button" disabled={currentCount === 0 || busy} onClick={() => void copyCurrent()}>Copy current JSON</button>
      </section>
      <div className="library-interchange-boundary">
        <strong>Compatibility boundary</strong>
        {kind === 'pixel'
          ? <p>Referenced colors match exactly by value. Missing colors are appended; import fails if the 256-color palette is full. Colors are never approximated.</p>
          : <p>Tile stamps import only into a map with the exact exported tileset and source-sprite identities, revisions, GID ranges, and geometry. Tileset pixels are not bundled or rebased.</p>}
      </div>
      <label className="dialog-field library-interchange-json"><span>Paste or load AIDraw stamp-library JSON</span><textarea autoFocus rows={10} maxLength={MAX_STAMP_LIBRARY_BYTES} spellCheck={false} value={json} onChange={(event) => changeJson(event.target.value)} placeholder='{"format":"aidraw-stamp-library","version":1,…}' /></label>
      <div className="library-interchange-actions"><label className="library-interchange-file">Load JSON file<input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void loadFile(file); }} /></label><small>16 MiB · 262,144 cells · canonical per-library and per-stamp limits still apply</small></div>
      <fieldset className="library-interchange-modes"><legend>Import behavior</legend>
        <label><input type="radio" name="stamp-library-mode" checked={mode === 'append'} onChange={() => changeMode('append')} /><span><strong>Add copies</strong><small>Keep this library; imported stamps receive fresh IDs and unique names.</small></span></label>
        <label><input type="radio" name="stamp-library-mode" checked={mode === 'replace'} onChange={() => changeMode('replace')} /><span><strong>Replace library</strong><small>Remove the current {kind} stamps and preserve the imported library IDs.</small></span></label>
      </fieldset>
      {plan && previewIsCurrent && <div className="library-interchange-summary" role="status"><strong>Preview ready</strong><span>{plan.incomingCount} incoming → {plan.totalCount} total stamp{plan.totalCount === 1 ? '' : 's'}{addedColors > 0 ? ` · ${addedColors} exact palette color${addedColors === 1 ? '' : 's'} added` : ''}</span><small>No document operation has run yet.</small></div>}
      {plan && !previewIsCurrent && <p className="entry-dialog-error" role="status">The document changed after preview. Preview again before applying.</p>}
      {notice && <p className="library-interchange-notice" role="status">{notice}</p>}
      {error && <p className="entry-dialog-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer library-interchange-footer"><button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button><button type="button" disabled={busy || !json.trim()} onClick={preview}>Preview import</button><button type="button" className="primary-modal-button" disabled={busy || !previewIsCurrent} onClick={() => void applyPreview()}>{busy ? 'Applying…' : mode === 'replace' ? 'Replace library' : 'Add copies'}</button></footer>
  </EditorDialog>;
}
