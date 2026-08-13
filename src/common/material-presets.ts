import {
  HUMAN_ACTOR,
  createId,
  nowIso,
  type CanvasOperation,
  type IllustrationDocument,
  type IllustrationLayer,
  type IllustrationObject,
  type PaintStyle,
  type PathObject,
  type ShapeObject,
  type StrokeStyle,
} from '@aidraw/core';

type MaterialSource = ShapeObject | PathObject;

export interface MaterialPresetBuild {
  operations: CanvasOperation[];
  selectedObjectIds: string[];
  groupLayerId: string;
  materialLayerId: string;
}

interface LocalBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const noPaint: PaintStyle = { kind: 'none' };

function localBounds(object: MaterialSource): LocalBounds {
  if (object.type === 'shape') return { x: 0, y: 0, width: Math.max(1, Math.abs(object.width)), height: Math.max(1, Math.abs(object.height)) };
  const values = object.pathData.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number).filter(Number.isFinite) ?? [];
  const xs: number[] = []; const ys: number[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) { xs.push(values[index]); ys.push(values[index + 1]); }
  if (!xs.length) return { x: 0, y: 0, width: 100, height: 100 };
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function gradient(bounds: LocalBounds, stops: Array<{ offset: number; color: string }>): PaintStyle {
  return {
    kind: 'linear-gradient',
    x1: bounds.x,
    y1: bounds.y + bounds.height * .82,
    x2: bounds.x + bounds.width,
    y2: bounds.y + bounds.height * .18,
    stops,
  };
}

function stroke(paint: PaintStyle, width: number): StrokeStyle {
  return { paint, width, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] };
}

function cloneMaterialObject(
  source: MaterialSource,
  name: string,
  layerId: string,
  createdAt: string,
  createdBy: string,
  fill: PaintStyle,
  outline: StrokeStyle,
  options: { opacity: number; blendMode: IllustrationObject['blendMode']; blur?: number; transformOffsetY?: number },
): MaterialSource {
  return {
    ...structuredClone(source),
    id: createId('material'),
    revision: 0,
    name,
    createdAt,
    updatedAt: createdAt,
    createdBy,
    layerId,
    fill,
    stroke: outline,
    opacity: options.opacity,
    blendMode: options.blendMode,
    blur: options.blur,
    maskObjectId: source.id,
    shadow: undefined,
    transform: { ...source.transform, y: source.transform.y + (options.transformOffsetY ?? 0) },
  };
}

/**
 * Builds an editable polished-gold stack around one selected vector shape/path.
 * The original object remains the clipping silhouette and all reflection objects
 * are ordinary vector entities, so every band, blur, opacity, and blend mode can
 * be adjusted after applying the preset.
 */
export function buildPolishedGoldMaterial(
  document: IllustrationDocument,
  source: IllustrationObject,
  createdBy = HUMAN_ACTOR.id,
): MaterialPresetBuild {
  if (source.type !== 'shape' && source.type !== 'path') throw new Error('Polished Gold requires one selected vector shape or path.');
  const sourceLayer = document.layers[source.layerId];
  if (!sourceLayer || sourceLayer.type !== 'vector') throw new Error('The selected object must belong to a vector layer.');

  const createdAt = nowIso(); const bounds = localBounds(source); const groupLayerId = createId('material-group'); const materialLayerId = createId('material-layer');
  const siblings = sourceLayer.parentId ? document.layers[sourceLayer.parentId] : undefined;
  const siblingIds = siblings?.type === 'group' ? siblings.childIds : document.layerIds;
  const sourceLayerIndex = Math.max(0, siblingIds.indexOf(sourceLayer.id));

  const groupLayer: IllustrationLayer = {
    id: groupLayerId, revision: 0, name: `Polished Gold · ${source.name}`, createdAt, updatedAt: createdAt, createdBy,
    visible: true, locked: false, opacity: 1, blendMode: 'normal', type: 'group', childIds: [], parentId: sourceLayer.parentId,
  };
  const materialLayer: IllustrationLayer = {
    id: materialLayerId, revision: 0, name: 'Editable reflection stack', createdAt, updatedAt: createdAt, createdBy,
    visible: true, locked: false, opacity: 1, blendMode: 'normal', type: 'vector', objectIds: [], parentId: groupLayerId,
  };

  const edgeWidth = Math.max(1.5, source.stroke.width || Math.min(bounds.width, bounds.height) * .025);
  const base: MaterialSource = {
    ...structuredClone(source),
    layerId: materialLayerId,
    name: `${source.name} · Gold base`,
    fill: gradient(bounds, [
      { offset: 0, color: '#4A2306' }, { offset: .1, color: '#7B450C' }, { offset: .22, color: '#D39B2F' },
      { offset: .38, color: '#FFE79A' }, { offset: .48, color: '#A5640D' }, { offset: .62, color: '#F7D267' },
      { offset: .78, color: '#B66F12' }, { offset: .9, color: '#F2C852' }, { offset: 1, color: '#522806' },
    ]),
    stroke: stroke({ kind: 'solid', color: '#5B2D08' }, edgeWidth),
    shadow: source.shadow ?? { color: '#27120466', blur: 18, offsetX: 0, offsetY: 10 },
  };

  const reflection = cloneMaterialObject(source, 'Gold · Reflection bands', materialLayerId, createdAt, createdBy, gradient(bounds, [
    { offset: 0, color: '#2D1300BB' }, { offset: .13, color: '#5E3007AA' }, { offset: .14, color: '#D6962444' },
    { offset: .28, color: '#FFF0AFAA' }, { offset: .36, color: '#FFF7D855' }, { offset: .37, color: '#6B3507CC' },
    { offset: .49, color: '#9D5B0BAA' }, { offset: .5, color: '#F5C95055' }, { offset: .63, color: '#FFF6C8CC' },
    { offset: .7, color: '#D0912033' }, { offset: .71, color: '#703806BB' }, { offset: .84, color: '#D99F2D88' },
    { offset: .94, color: '#FFF0A566' }, { offset: 1, color: '#3A1900BB' },
  ]), stroke(noPaint, 0), { opacity: .78, blendMode: 'overlay', blur: 4 });

  const sheen = cloneMaterialObject(source, 'Gold · Soft reflected light', materialLayerId, createdAt, createdBy, gradient(bounds, [
    { offset: 0, color: '#FFF9DF00' }, { offset: .3, color: '#FFF9DF00' }, { offset: .46, color: '#FFF9DF44' },
    { offset: .55, color: '#FFFFFFDD' }, { offset: .64, color: '#FFF4BB55' }, { offset: .82, color: '#FFF4BB00' }, { offset: 1, color: '#FFF4BB00' },
  ]), stroke(noPaint, 0), { opacity: .62, blendMode: 'screen', blur: 12 });

  const specular = cloneMaterialObject(source, 'Gold · Sharp specular', materialLayerId, createdAt, createdBy, gradient(bounds, [
    { offset: 0, color: '#FFFFFF00' }, { offset: .39, color: '#FFFFFF00' }, { offset: .435, color: '#FFFBEA55' },
    { offset: .47, color: '#FFFFFFFF' }, { offset: .505, color: '#FFFBEA55' }, { offset: .55, color: '#FFFFFF00' }, { offset: 1, color: '#FFFFFF00' },
  ]), stroke(noPaint, 0), { opacity: .9, blendMode: 'screen', blur: 1.25 });

  const depth = cloneMaterialObject(source, 'Gold · Inner depth', materialLayerId, createdAt, createdBy, noPaint, stroke({ kind: 'solid', color: '#351603' }, edgeWidth * 1.8), { opacity: .55, blendMode: 'multiply', blur: .8, transformOffsetY: 1.5 });
  const edge = cloneMaterialObject(source, 'Gold · Bright rim', materialLayerId, createdAt, createdBy, noPaint, stroke(gradient(bounds, [
    { offset: 0, color: '#8A4D08' }, { offset: .3, color: '#FFEAA0' }, { offset: .5, color: '#FFFFFF' }, { offset: .72, color: '#F7C84A' }, { offset: 1, color: '#6A3506' },
  ]), edgeWidth), { opacity: .94, blendMode: 'screen', blur: .45 });

  const overlays = [reflection, sheen, specular, depth, edge];
  return {
    operations: [
      { kind: 'illustration.layer.add', layer: groupLayer, index: sourceLayerIndex + 1 },
      { kind: 'illustration.layer.add', layer: materialLayer },
      { kind: 'illustration.object.replace', object: { ...base, layerId: source.layerId }, expectedRevision: source.revision },
      { kind: 'illustration.object.move', objectId: source.id, layerId: materialLayerId, expectedRevision: source.revision + 1 },
      ...overlays.map((object): CanvasOperation => ({ kind: 'illustration.object.add', object })),
    ],
    selectedObjectIds: [source.id, ...overlays.map((object) => object.id)],
    groupLayerId,
    materialLayerId,
  };
}
