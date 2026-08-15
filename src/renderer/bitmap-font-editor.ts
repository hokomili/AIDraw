import { MAX_BITMAP_GLYPH_AXIS, resizeBitmapGlyph, type BitmapGlyph } from '@aidraw/core';

export type BitmapGlyphDimensionAxis = 'width' | 'height';

export interface BitmapGlyphDimensionDraftState {
  glyph: BitmapGlyph;
  width: string;
  height: string;
}

export function createBitmapGlyphDimensionDraft(glyph: BitmapGlyph): BitmapGlyphDimensionDraftState {
  const cloned = { width: glyph.width, advance: glyph.advance, rows: [...glyph.rows] };
  return { glyph: cloned, width: String(cloned.width), height: String(cloned.rows.length) };
}

/** Keep keyboard drafts separate from the editable cell buffer until an explicit commit. */
export function updateBitmapGlyphDimensionDraft(
  state: BitmapGlyphDimensionDraftState,
  axis: BitmapGlyphDimensionAxis,
  value: string,
): BitmapGlyphDimensionDraftState {
  return { ...state, [axis]: value };
}

export function cancelBitmapGlyphDimensionDraft(
  state: BitmapGlyphDimensionDraftState,
  axis: BitmapGlyphDimensionAxis,
): BitmapGlyphDimensionDraftState {
  return { ...state, [axis]: String(axis === 'width' ? state.glyph.width : state.glyph.rows.length) };
}

export function commitBitmapGlyphDimensionDraft(
  state: BitmapGlyphDimensionDraftState,
  axis: BitmapGlyphDimensionAxis,
): { state: BitmapGlyphDimensionDraftState; error?: string } {
  const draft = state[axis];
  const value = Number(draft);
  const label = axis === 'width' ? 'width' : 'height';
  if (!draft.trim() || !Number.isInteger(value) || value < 1 || value > MAX_BITMAP_GLYPH_AXIS) {
    return {
      state: cancelBitmapGlyphDimensionDraft(state, axis),
      error: `Bitmap glyph ${label} must be a whole number from 1 through ${MAX_BITMAP_GLYPH_AXIS}. The editable grid was left unchanged.`,
    };
  }
  const nextGlyph = axis === 'width'
    ? value === state.glyph.width ? state.glyph : resizeBitmapGlyph(state.glyph, value, state.glyph.rows.length)
    : value === state.glyph.rows.length ? state.glyph : resizeBitmapGlyph(state.glyph, state.glyph.width, value);
  return {
    state: {
      ...state,
      glyph: nextGlyph,
      [axis]: String(value),
    },
  };
}

export interface BitmapGlyphGridKeyAction {
  x: number;
  y: number;
  activate?: true;
}

export interface BitmapGlyphFocusableCell {
  focus: () => void;
}

export interface BitmapGlyphCellFocusRegistry<Cell extends BitmapGlyphFocusableCell> {
  refFor: (x: number, y: number) => (node: Cell | null) => void;
  focus: (x: number, y: number) => boolean;
}

/** Keep ref identity and lookup bound to a logical cell, never a width-derived array slot. */
export function createBitmapGlyphCellFocusRegistry<Cell extends BitmapGlyphFocusableCell>(): BitmapGlyphCellFocusRegistry<Cell> {
  const nodes = new Map<string, Cell>();
  const callbacks = new Map<string, (node: Cell | null) => void>();
  const keyFor = (x: number, y: number) => `${x}:${y}`;
  return {
    refFor(x, y) {
      const key = keyFor(x, y);
      const existing = callbacks.get(key);
      if (existing) return existing;
      const callback = (node: Cell | null) => {
        if (node) nodes.set(key, node);
        else nodes.delete(key);
      };
      callbacks.set(key, callback);
      return callback;
    },
    focus(x, y) {
      const node = nodes.get(keyFor(x, y));
      if (!node) return false;
      node.focus();
      return true;
    },
  };
}

/** Resolve one bounded composite-grid keyboard action without wrapping rows or columns. */
export function bitmapGlyphGridKeyAction({
  x,
  y,
  width,
  height,
  key,
  ctrlKey = false,
  metaKey = false,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): BitmapGlyphGridKeyAction | undefined {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || x < 0 || y < 0 || x >= width || y >= height) return undefined;
  if (key === 'Enter' || key === ' ') return { x, y, activate: true };
  if (key === 'ArrowLeft') return { x: Math.max(0, x - 1), y };
  if (key === 'ArrowRight') return { x: Math.min(width - 1, x + 1), y };
  if (key === 'ArrowUp') return { x, y: Math.max(0, y - 1) };
  if (key === 'ArrowDown') return { x, y: Math.min(height - 1, y + 1) };
  if (key === 'Home') return ctrlKey || metaKey ? { x: 0, y: 0 } : { x: 0, y };
  if (key === 'End') return ctrlKey || metaKey ? { x: width - 1, y: height - 1 } : { x: width - 1, y };
  return undefined;
}
