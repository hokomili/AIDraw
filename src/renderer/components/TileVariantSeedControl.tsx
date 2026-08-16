import { Dices } from 'lucide-react';

import { parseTileVariantSeedDraft } from '../tile-variant-seed';

export function TileVariantSeedControl({ group, candidateCount, seed, onSeedBlur, onNewStroke }: {
  group: string;
  candidateCount: number;
  seed: number;
  onSeedBlur: (seed: number) => void;
  onNewStroke: () => void;
}) {
  return <div className="variant-seed-control" role="group" aria-label={`Weighted tile variant stroke controls for group ${group}`} title={`${candidateCount} weighted tiles in “${group}”`}>
    <span className="variant-seed-summary">
      <strong>Variant group</strong>
      <span>“{group}”</span>
      <small>{candidateCount} weighted tile{candidateCount === 1 ? '' : 's'}</small>
    </span>
    <label className="variant-seed-field">
      <span>Signed seed</span>
      <input aria-label={`Signed tile variant seed for group ${group}`} type="number" step={1} defaultValue={seed} onBlur={(event) => onSeedBlur(parseTileVariantSeedDraft(event.target.value))} />
    </label>
    <button type="button" onClick={onNewStroke} aria-label={`Start a new weighted tile variant stroke for group ${group}`} title="Persist the deterministic next seed for subsequent variant strokes; existing painted tiles do not change">
      <Dices aria-hidden="true" />
      <span><strong>New stroke</strong><small>Advance seed only</small></span>
    </button>
  </div>;
}
