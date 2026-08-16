import { useState } from 'react';
import type { PixelDocument, PixelTilemap } from '@aidraw/core';
import {
  MAX_STAMP_LIBRARY_BYTES,
  parseStampLibraryJson,
  prepareStampLibraryImport,
  serializePixelStampLibrary,
  serializePortableTileStampKit,
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
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const changeJson = (value: string) => {
    setJson(value);
    setPlan(undefined);
    setError(undefined);
    setNotice(undefined);
  };
  const changeMode = (value: StampLibraryImportMode) => {
    setMode(value);
    setPlan(undefined);
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
    try { setPlan(buildPlan()); } catch (caught) { setPlan(undefined); setError(errorMessage(caught)); }
  };
  const copyCurrent = async (portable = false) => {
    setError(undefined);
    setNotice(undefined);
    try {
      const serialized = map
        ? portable ? serializePortableTileStampKit(document, map) : serializeTileStampLibrary(document, map)
        : serializePixelStampLibrary(document);
      await navigator.clipboard.writeText(serialized);
      setNotice(`Copied ${currentCount} ${kind} stamp${currentCount === 1 ? '' : 's'} as ${portable ? 'a portable AIDraw kit' : 'AIDraw exact-reference JSON'}.`);
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
    if (!plan || plan.expectedDocumentId !== document.id || plan.expectedDocumentRevision !== document.revision || (plan.expectedMapId && plan.expectedMapId !== map?.id)) return;
    setBusy(true);
    setError(undefined);
    try {
      if (await onApply(plan)) onClose();
      else setError('The stamp library transaction was not applied.');
    } catch (caught) { setPlan(undefined); setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };
  const paletteOperation = plan?.operations.find((operation) => operation.kind === 'pixel.palette.replace');
  const addedColors = paletteOperation?.kind === 'pixel.palette.replace' ? paletteOperation.palette.length - document.palette.length : 0;
  const previewIsCurrent = Boolean(plan
    && plan.expectedDocumentId === document.id
    && plan.expectedDocumentRevision === document.revision
    && (!plan.expectedMapId || plan.expectedMapId === map?.id));
  const portable = plan?.portable;

  return <EditorDialog
    title={`${kind === 'pixel' ? 'Pixel' : 'Tile'} stamp library JSON`}
    description={`Copy or import the reusable ${kind} stamps owned by this document. Parsing and preview do not change the document.`}
    className="library-interchange-dialog"
    onClose={onClose}
  >
    <div className="library-interchange-body">
      <section className="library-interchange-current">
        <span><strong>Current library</strong><small>{currentCount} reusable {kind} stamp{currentCount === 1 ? '' : 's'}</small></span>
        <span className="library-interchange-copy-actions">
          {map && <button type="button" disabled={currentCount === 0 || busy} onClick={() => void copyCurrent(true)}>Copy portable kit</button>}
          <button type="button" disabled={currentCount === 0 || busy} onClick={() => void copyCurrent(false)}>{map ? 'Copy exact-reference JSON' : 'Copy current JSON'}</button>
        </span>
      </section>
      <div className="library-interchange-boundary">
        <strong>Compatibility boundary</strong>
        {kind === 'pixel'
          ? <p>Referenced colors match exactly by value. Missing colors are appended; import fails if the 256-color palette is full. Colors are never approximated.</p>
          : <p>Version 1 exact-reference JSON keeps predecessor clone/shared-project behavior. A reviewed version 2 portable kit carries every and only required tilesets and sprite sources. Byte-identical tilesets reuse only when already attached; otherwise exact fresh copies and complete safe ranges are planned. Bounded checks preserve every existing cell, tile-object, and retained-stamp GID meaning before exact palette slots and dependencies are added and only imported stamp base GIDs rebase. Existing assets, maps, cells, and source projects are never rewritten or deleted.</p>}
      </div>
      <label className="dialog-field library-interchange-json"><span>Paste or load AIDraw stamp-library JSON</span><textarea autoFocus rows={10} maxLength={MAX_STAMP_LIBRARY_BYTES} spellCheck={false} value={json} onChange={(event) => changeJson(event.target.value)} placeholder='{"format":"aidraw-stamp-library","version":1|2,…}' /></label>
      <div className="library-interchange-actions"><label className="library-interchange-file">Load JSON file<input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void loadFile(file); }} /></label><small>16 MiB · 262,144 cells · portable kits: 128 assets, 64 tilesets, 4,194,304 logical/stored source pixels, 1,500,000 planned bytes/256 operations</small></div>
      <fieldset className="library-interchange-modes"><legend>Import behavior</legend>
        <label><input type="radio" name="stamp-library-mode" checked={mode === 'append'} onChange={() => changeMode('append')} /><span><strong>Add copies</strong><small>Keep this library. Portable stamps receive fresh IDs and retain authored names; version 1 retains predecessor unique-name behavior.</small></span></label>
        <label><input type="radio" name="stamp-library-mode" checked={mode === 'replace'} onChange={() => changeMode('replace')} /><span><strong>Replace stamp library</strong><small>Replace only the current {kind} stamps. Existing project assets, maps, cells, and sources remain.</small></span></label>
      </fieldset>
      {plan && previewIsCurrent && <div className="library-interchange-summary" role="status"><strong>Preview ready · version {plan.formatVersion}</strong><span>{plan.incomingCount} incoming → {plan.totalCount} total stamp{plan.totalCount === 1 ? '' : 's'}{addedColors > 0 ? ` · ${addedColors} exact palette color${addedColors === 1 ? '' : 's'} added` : ''}</span>
        {portable && <div className="library-interchange-portable-summary">
          <span>Stamps: {portable.stampNames.slice(0, 8).join(', ')}{portable.stampNames.length > 8 ? ` +${portable.stampNames.length - 8} more` : ''}</span>
          <span>Dependencies: {portable.copiedTilesetCount} tileset{portable.copiedTilesetCount === 1 ? '' : 's'} copied, {portable.reusedTilesetCount} reused · {portable.copiedSpriteCount} sprite{portable.copiedSpriteCount === 1 ? '' : 's'} copied, {portable.reusedSpriteCount} reused</span>
          {portable.dependencies.map((dependency) => <span key={dependency.sourceTilesetId}>{dependency.sourceTilesetName}: GID {dependency.sourceFirstGid}–{dependency.sourceLastGid} → {dependency.targetFirstGid}–{dependency.targetLastGid} ({dependency.disposition})</span>)}
          {portable.sources.map((source) => <span key={source.sourceAssetId}>{source.sourceAssetName}: source {source.sourceAssetId} → {source.targetAssetId} ({source.disposition})</span>)}
          <span>Palette: {portable.paletteAdditions.length ? portable.paletteAdditions.slice(0, 8).map((entry) => `${entry.name} ${entry.color}`).join(', ') : 'no additions'}{portable.paletteAdditions.length > 8 ? ` +${portable.paletteAdditions.length - 8} more` : ''}</span>
          <span>Map attachments: {portable.mapAttachments.length ? portable.mapAttachments.map((entry) => `${entry.name} (${entry.tilesetId})`).join(', ') : 'none'} · {portable.rebasedCellCount} nonzero GID{portable.rebasedCellCount === 1 ? '' : 's'} rebased</span>
        </div>}
        <small>No document operation has run yet. Apply uses this frozen, document-bound preview.</small></div>}
      {plan && !previewIsCurrent && <p className="entry-dialog-error" role="status">The document changed after preview. Preview again before applying.</p>}
      {notice && <p className="library-interchange-notice" role="status">{notice}</p>}
      {error && <p className="entry-dialog-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer library-interchange-footer"><button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button><button type="button" disabled={busy || !json.trim()} onClick={preview}>Preview import</button><button type="button" className="primary-modal-button" disabled={busy || !previewIsCurrent} onClick={() => void applyPreview()}>{busy ? 'Applying…' : mode === 'replace' ? 'Replace library' : 'Add copies'}</button></footer>
  </EditorDialog>;
}
