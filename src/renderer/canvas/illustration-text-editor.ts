import { textStyleAt, type GroupObject, type IllustrationDocument, type IllustrationLayer, type IllustrationObject, type TextObject } from '@aidraw/core';
import type { CSSProperties } from 'react';
import { canvasFont } from '../../common/canvas-font';
import { objectMatrix } from './illustration-hit-test';

export interface IllustrationTextEditorView {
  scale: number;
  offsetX: number;
  offsetY: number;
}

function cssNumber(value: number): number {
  return Math.abs(value) < 1e-12 ? 0 : value;
}

interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

function affineMatrix(object: IllustrationObject): AffineMatrix {
  const value = objectMatrix(object);
  return { a: value.a!, b: value.b!, c: value.c!, d: value.d!, e: value.e!, f: value.f! };
}

function multiply(left: AffineMatrix, right: AffineMatrix): AffineMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function parentGroupChain(document: IllustrationDocument, objectId: string): { parents: GroupObject[]; valid: boolean } {
  const parentByChild = new Map<string, GroupObject>();
  for (const object of Object.values(document.objects)) {
    if (object.type !== 'group') continue;
    for (const childId of object.childIds) parentByChild.set(childId, object);
  }
  const parents: GroupObject[] = [];
  const seen = new Set([objectId]);
  let currentId = objectId;
  for (;;) {
    const parent = parentByChild.get(currentId);
    if (!parent) return { parents: parents.reverse(), valid: true };
    if (seen.has(parent.id)) return { parents: [], valid: false };
    seen.add(parent.id);
    parents.push(parent);
    currentId = parent.id;
  }
}

export function illustrationTextObjectIsEditable(document: IllustrationDocument, object: IllustrationObject | undefined): object is TextObject {
  if (object?.type !== 'text' || !object.visible || object.locked) return false;
  const hierarchy = parentGroupChain(document, object.id);
  if (!hierarchy.valid || hierarchy.parents.some((parent) => parent.layerId !== object.layerId || !parent.visible || parent.locked)) return false;
  let layer = document.layers[object.layerId];
  if (layer?.type !== 'vector') return false;
  const rootObjectId = hierarchy.parents[0]?.id ?? object.id;
  if (!layer.objectIds.includes(rootObjectId)) return false;
  const seen = new Set<string>();
  let childLayerId = layer.id;
  while (layer) {
    if (seen.has(layer.id) || !layer.visible || layer.locked) return false;
    seen.add(layer.id);
    if (!layer.parentId) return document.layerIds.includes(layer.id);
    const parent: IllustrationLayer | undefined = document.layers[layer.parentId];
    if (parent?.type !== 'group' || !parent.childIds.includes(childLayerId)) return false;
    childLayerId = parent.id;
    layer = parent;
  }
  return false;
}

export function illustrationTextWorldMatrix(document: IllustrationDocument, object: TextObject): AffineMatrix {
  const hierarchy = parentGroupChain(document, object.id);
  let matrix: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  if (hierarchy.valid) for (const parent of hierarchy.parents) matrix = multiply(matrix, affineMatrix(parent));
  return multiply(matrix, affineMatrix(object));
}

/**
 * Places the DOM content editor over the same local box and object affine
 * transform used by Canvas. The textarea deliberately uses the style at the
 * first character; per-range typography remains visible in Canvas and editable in
 * the inspector after the content transaction commits.
 */
export function illustrationTextEditorStyle(document: IllustrationDocument, object: TextObject, view: IllustrationTextEditorView): CSSProperties {
  const matrix = illustrationTextWorldMatrix(document, object);
  const style = textStyleAt(object, 0);
  const values = [
    view.scale * matrix.a!,
    view.scale * matrix.b!,
    view.scale * matrix.c!,
    view.scale * matrix.d!,
    view.offsetX + view.scale * matrix.e!,
    view.offsetY + view.scale * matrix.f!,
  ].map(cssNumber);
  return {
    width: object.width,
    height: object.height,
    transform: `matrix(${values.join(', ')})`,
    transformOrigin: '0 0',
    font: canvasFont(style),
    lineHeight: object.lineHeight,
    letterSpacing: `${style.letterSpacing}px`,
    color: style.color,
    textAlign: object.align,
    textDecoration: style.underline ? 'underline' : 'none',
  };
}
