import type { PathObject, Transform } from '@aidraw/core';
import {
  inspectPathNodes,
  joinPathData,
  transformPathData,
  type PathAffineMatrix,
  type PathEndpoint,
} from './path-nodes';

export type PathJoinMode = 'nearest' | 'end-start' | 'start-end' | 'start-start' | 'end-end';

function objectMatrix(transform: Transform): PathAffineMatrix {
  const angle = transform.rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const skewX = Math.tan(transform.skewX * Math.PI / 180);
  const skewY = Math.tan(transform.skewY * Math.PI / 180);
  return {
    a: cosine * transform.scaleX - sine * skewY,
    b: sine * transform.scaleX + cosine * skewY,
    c: cosine * skewX - sine * transform.scaleY,
    d: sine * skewX + cosine * transform.scaleY,
    e: transform.x,
    f: transform.y,
  };
}

function invert(matrix: PathAffineMatrix): PathAffineMatrix {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < 1e-10) throw new Error('A path with a zero-scale transform cannot be joined.');
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
}

function multiply(left: PathAffineMatrix, right: PathAffineMatrix): PathAffineMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function apply(matrix: PathAffineMatrix, value: { x: number; y: number }): { x: number; y: number } {
  return {
    x: matrix.a * value.x + matrix.c * value.y + matrix.e,
    y: matrix.b * value.x + matrix.d * value.y + matrix.f,
  };
}

function endpoints(object: PathObject): Record<PathEndpoint, { x: number; y: number }> {
  const nodes = inspectPathNodes(object.pathData);
  const matrix = objectMatrix(object.transform);
  return {
    start: apply(matrix, nodes[0].anchor),
    end: apply(matrix, nodes.at(-1)!.anchor),
  };
}

function endpointPair(primary: PathObject, secondary: PathObject, mode: PathJoinMode): [PathEndpoint, PathEndpoint] {
  if (mode !== 'nearest') return mode.split('-') as [PathEndpoint, PathEndpoint];
  const first = endpoints(primary);
  const second = endpoints(secondary);
  const candidates: Array<[PathEndpoint, PathEndpoint]> = [
    ['end', 'start'],
    ['start', 'end'],
    ['start', 'start'],
    ['end', 'end'],
  ];
  return candidates.reduce((best, candidate) => {
    const distance = Math.hypot(first[candidate[0]].x - second[candidate[1]].x, first[candidate[0]].y - second[candidate[1]].y);
    const bestDistance = Math.hypot(first[best[0]].x - second[best[1]].x, first[best[0]].y - second[best[1]].y);
    return distance < bestDistance ? candidate : best;
  });
}

/** Joins secondary into primary while preserving both objects' world-space geometry. */
export function joinPathObjects(primary: PathObject, secondary: PathObject, mode: PathJoinMode = 'nearest'): PathObject {
  if (primary.id === secondary.id) throw new Error('Select two different paths to join.');
  if (primary.closed || secondary.closed) throw new Error('Only open paths can be joined. Cut a closed path first.');
  const [primaryEndpoint, secondaryEndpoint] = endpointPair(primary, secondary, mode);
  const secondaryToPrimary = multiply(invert(objectMatrix(primary.transform)), objectMatrix(secondary.transform));
  return {
    ...primary,
    name: `${primary.name} + ${secondary.name}`,
    pathData: joinPathData(primary.pathData, transformPathData(secondary.pathData, secondaryToPrimary), primaryEndpoint, secondaryEndpoint),
    closed: false,
  };
}
