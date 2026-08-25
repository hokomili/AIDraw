import paper from 'paper';
import {
  MAX_EDITABLE_SVG_PATH_CHARACTERS,
  MAX_EDITABLE_SVG_PATH_NODES,
  inspectEditableSvgPathData,
  normalizeSvgPathData,
  type SvgPathInspection,
} from '@aidraw/core';
import { inspectPathNodes } from './path-nodes';

export function convertPathArcsToCubics(pathData: string): { pathData: string; closed: boolean } {
  if (typeof pathData !== 'string' || pathData.length < 3 || pathData.length > MAX_EDITABLE_SVG_PATH_CHARACTERS) throw new Error('Path data is empty or exceeds the one-million-character conversion limit.');
  const scope = new paper.PaperScope(); scope.setup(new scope.Size(1, 1));
  try {
    const item = scope.PathItem.create(normalizeSvgPathData(pathData)); if (!item) throw new Error('Path data could not be parsed.');
    if (item.className !== 'Path') throw new Error('Arc conversion currently supports one simple subpath.');
    const path = item as paper.Path; const converted = path.pathData; if (!converted) throw new Error('Path conversion produced no geometry.');
    return { pathData: converted, closed: path.closed };
  } finally { scope.project.remove(); }
}

export interface NativeEditableSvgPathInspection extends SvgPathInspection {
  effectiveNodeCount: number;
}

/**
 * Binds strict grammar admission to the exact native conversion and node
 * implementation used by editing. This rejects geometry Paper.js omits or
 * coalesces before it can enter a public/imported canonical mutation.
 */
export function inspectNativeEditableSvgPathData(pathData: string): NativeEditableSvgPathInspection {
  const inspection = inspectEditableSvgPathData(pathData);
  const nativePathData = inspection.hasArc ? convertPathArcsToCubics(pathData).pathData : pathData;
  let effectiveNodeCount: number;
  try { effectiveNodeCount = inspectPathNodes(nativePathData).length; }
  catch (error) {
    throw new Error(`Editable SVG path cannot complete native node editing: ${error instanceof Error ? error.message : 'invalid native topology'}`);
  }
  if (effectiveNodeCount < 2 || effectiveNodeCount > MAX_EDITABLE_SVG_PATH_NODES) {
    throw new Error(`Editable SVG paths must retain 2–${MAX_EDITABLE_SVG_PATH_NODES.toLocaleString('en-US')} effective native nodes after arc conversion and close coalescing.`);
  }
  return { ...inspection, effectiveNodeCount };
}
