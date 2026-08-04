export type PathPointKind = 'anchor' | 'in' | 'out';
export type PathNodeKind = 'corner' | 'smooth';
export type PathEndpoint = 'start' | 'end';

export interface PathAffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface SplitPathResult {
  primaryPathData: string;
  secondaryPathData?: string;
}

interface Point { x: number; y: number }
interface EditableNode { point: Point; handleIn: Point; handleOut: Point }
interface EditablePath { nodes: EditableNode[]; closed: boolean }

export interface PathNodeDescriptor {
  index: number;
  anchor: Point;
  handleIn: Point;
  handleOut: Point;
  hasHandleIn: boolean;
  hasHandleOut: boolean;
  kind: PathNodeKind;
}

export interface NearestPathLocation {
  segmentIndex: number;
  time: number;
  distance: number;
  point: Point;
}

const COMMAND = /^[a-z]$/i;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const EPSILON = 1e-7;

function point(x = 0, y = 0): Point { return { x, y }; }
function add(left: Point, right: Point): Point { return point(left.x + right.x, left.y + right.y); }
function subtract(left: Point, right: Point): Point { return point(left.x - right.x, left.y - right.y); }
function multiply(value: Point, factor: number): Point { return point(value.x * factor, value.y * factor); }
function length(value: Point): number { return Math.hypot(value.x, value.y); }
function distance(left: Point, right: Point): number { return length(subtract(left, right)); }
function lerp(left: Point, right: Point, time: number): Point { return add(left, multiply(subtract(right, left), time)); }
function zero(): Point { return point(0, 0); }
function clonePoint(value: Point): Point { return point(value.x, value.y); }

function tokens(pathData: string): string[] {
  if (typeof pathData !== 'string' || pathData.length < 3 || pathData.length > 1_000_000) throw new Error('Path data is empty or exceeds the one-million-character editing limit.');
  const result = pathData.match(/[a-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? [];
  if (!result.length) throw new Error('Path data contains no commands.');
  return result;
}

function parsePath(pathData: string): EditablePath {
  const values = tokens(pathData);
  const nodes: EditableNode[] = [];
  let cursor = 0;
  let command = '';
  let current = point();
  let start = point();
  let closed = false;
  let priorCommand = '';
  let quadraticControl: Point | undefined;

  const readNumber = (): number => {
    const token = values[cursor++];
    if (!token || !NUMBER.test(token)) throw new Error(`Path command ${command || '?'} is missing a numeric parameter.`);
    const number = Number(token);
    if (!Number.isFinite(number)) throw new Error('Path coordinates must be finite.');
    return number;
  };
  const readPoint = (relative: boolean): Point => {
    const value = point(readNumber(), readNumber());
    return relative ? add(current, value) : value;
  };
  const addLineNode = (target: Point) => { nodes.push({ point: target, handleIn: zero(), handleOut: zero() }); current = target; };

  while (cursor < values.length) {
    if (COMMAND.test(values[cursor])) command = values[cursor++];
    else if (!command) throw new Error('Path data must begin each segment family with a command.');
    const lower = command.toLowerCase();
    const relative = command === lower;
    if (lower === 'z') {
      closed = true;
      if (nodes.length > 1 && distance(nodes.at(-1)!.point, nodes[0].point) < EPSILON) {
        nodes[0].handleIn = nodes.at(-1)!.handleIn;
        nodes.pop();
      }
      current = clonePoint(start); command = ''; priorCommand = 'z'; quadraticControl = undefined; continue;
    }
    if (lower === 'a') throw new Error('Arc commands must be converted to cubic curves before semantic node editing.');
    if (!['m', 'l', 'h', 'v', 'c', 's', 'q', 't'].includes(lower)) throw new Error(`Unsupported path command ${command}.`);

    if (lower === 'm') {
      const target = readPoint(relative);
      if (nodes.length) throw new Error('Semantic node editing currently supports one simple subpath.');
      nodes.push({ point: target, handleIn: zero(), handleOut: zero() });
      current = target; start = clonePoint(target); priorCommand = 'm'; quadraticControl = undefined;
      command = relative ? 'l' : 'L';
      continue;
    }
    if (!nodes.length) throw new Error('Path data must start with a move command.');

    if (lower === 'l') addLineNode(readPoint(relative));
    else if (lower === 'h') { const x = readNumber(); addLineNode(point(relative ? current.x + x : x, current.y)); }
    else if (lower === 'v') { const y = readNumber(); addLineNode(point(current.x, relative ? current.y + y : y)); }
    else if (lower === 'c') {
      const control1 = readPoint(relative); const control2 = readPoint(relative); const target = readPoint(relative);
      nodes.at(-1)!.handleOut = subtract(control1, current);
      nodes.push({ point: target, handleIn: subtract(control2, target), handleOut: zero() }); current = target;
    } else if (lower === 's') {
      const control1 = priorCommand === 'c' || priorCommand === 's' ? subtract(current, nodes.at(-1)!.handleIn) : clonePoint(current);
      const control2 = readPoint(relative); const target = readPoint(relative);
      nodes.at(-1)!.handleOut = subtract(control1, current);
      nodes.push({ point: target, handleIn: subtract(control2, target), handleOut: zero() }); current = target;
    } else if (lower === 'q') {
      const control = readPoint(relative); const target = readPoint(relative);
      nodes.at(-1)!.handleOut = multiply(subtract(control, current), 2 / 3);
      nodes.push({ point: target, handleIn: multiply(subtract(control, target), 2 / 3), handleOut: zero() });
      current = target; quadraticControl = control;
    } else if (lower === 't') {
      const control = (priorCommand === 'q' || priorCommand === 't') && quadraticControl ? subtract(multiply(current, 2), quadraticControl) : clonePoint(current);
      const target = readPoint(relative);
      nodes.at(-1)!.handleOut = multiply(subtract(control, current), 2 / 3);
      nodes.push({ point: target, handleIn: multiply(subtract(control, target), 2 / 3), handleOut: zero() });
      current = target; quadraticControl = control;
    }
    if (lower !== 'q' && lower !== 't') quadraticControl = undefined;
    priorCommand = lower;
  }
  if (nodes.length < 2 || nodes.length > 100_000) throw new Error('A path must contain 2–100,000 nodes for semantic editing.');
  return { nodes, closed };
}

function format(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Path coordinates must be finite.');
  const rounded = Math.abs(value) < 0.0000005 ? 0 : Math.round(value * 1_000_000) / 1_000_000;
  return String(rounded);
}

function serializePath(path: EditablePath): string {
  const { nodes } = path;
  if (nodes.length < 2) throw new Error('A path must retain at least two nodes.');
  let output = `M ${format(nodes[0].point.x)} ${format(nodes[0].point.y)}`;
  const appendCurve = (from: EditableNode, to: EditableNode) => {
    if (length(from.handleOut) > EPSILON || length(to.handleIn) > EPSILON) {
      const first = add(from.point, from.handleOut); const second = add(to.point, to.handleIn);
      output += ` C ${format(first.x)} ${format(first.y)} ${format(second.x)} ${format(second.y)} ${format(to.point.x)} ${format(to.point.y)}`;
    } else output += ` L ${format(to.point.x)} ${format(to.point.y)}`;
  };
  for (let index = 1; index < nodes.length; index += 1) appendCurve(nodes[index - 1], nodes[index]);
  if (path.closed) {
    const last = nodes.at(-1)!; const first = nodes[0];
    if (length(last.handleOut) > EPSILON || length(first.handleIn) > EPSILON) appendCurve(last, first);
    output += ' Z';
  }
  return output;
}

function reversePath(path: EditablePath): EditablePath {
  return {
    closed: path.closed,
    nodes: [...path.nodes].reverse().map((node) => ({
      point: clonePoint(node.point),
      handleIn: clonePoint(node.handleOut),
      handleOut: clonePoint(node.handleIn),
    })),
  };
}

function transformPoint(value: Point, matrix: PathAffineMatrix): Point {
  return point(
    matrix.a * value.x + matrix.c * value.y + matrix.e,
    matrix.b * value.x + matrix.d * value.y + matrix.f,
  );
}

function nodeKind(node: EditableNode): PathNodeKind {
  if (length(node.handleIn) < EPSILON || length(node.handleOut) < EPSILON) return 'corner';
  const cross = node.handleIn.x * node.handleOut.y - node.handleIn.y * node.handleOut.x;
  const dot = node.handleIn.x * node.handleOut.x + node.handleIn.y * node.handleOut.y;
  return Math.abs(cross) <= Math.max(EPSILON, length(node.handleIn) * length(node.handleOut) * 1e-4) && dot < 0 ? 'smooth' : 'corner';
}

function describe(node: EditableNode, index: number): PathNodeDescriptor {
  return { index, anchor: clonePoint(node.point), handleIn: add(node.point, node.handleIn), handleOut: add(node.point, node.handleOut), hasHandleIn: length(node.handleIn) > EPSILON, hasHandleOut: length(node.handleOut) > EPSILON, kind: nodeKind(node) };
}

export function inspectPathNodes(pathData: string): PathNodeDescriptor[] {
  return parsePath(pathData).nodes.map(describe);
}

export function movePathPoint(pathData: string, nodeIndex: number, pointKind: PathPointKind, x: number, y: number, mirror = false): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Path point coordinates must be finite.');
  const path = parsePath(pathData); const node = path.nodes[nodeIndex];
  if (!node) throw new Error(`Path node ${nodeIndex} does not exist.`);
  const target = point(x, y);
  if (pointKind === 'anchor') node.point = target;
  else {
    const vector = subtract(target, node.point);
    if (pointKind === 'in') node.handleIn = vector; else node.handleOut = vector;
    if (mirror && length(vector) > EPSILON) {
      const opposite = pointKind === 'in' ? node.handleOut : node.handleIn;
      const wantedLength = length(opposite) > EPSILON ? length(opposite) : length(vector);
      const mirrored = multiply(vector, -wantedLength / length(vector));
      if (pointKind === 'in') node.handleOut = mirrored; else node.handleIn = mirrored;
    }
  }
  return serializePath(path);
}

export function convertPathNode(pathData: string, nodeIndex: number, kind: PathNodeKind): string {
  const path = parsePath(pathData); const node = path.nodes[nodeIndex];
  if (!node) throw new Error(`Path node ${nodeIndex} does not exist.`);
  if (kind === 'corner') { node.handleIn = zero(); node.handleOut = zero(); }
  else {
    const previous = path.nodes[nodeIndex - 1] ?? (path.closed ? path.nodes.at(-1) : undefined);
    const next = path.nodes[nodeIndex + 1] ?? (path.closed ? path.nodes[0] : undefined);
    if (!previous || !next) throw new Error('An endpoint needs neighboring geometry before it can become a smooth node.');
    const direction = subtract(next.point, previous.point); const directionLength = length(direction);
    if (directionLength < EPSILON) throw new Error('Coincident neighboring nodes cannot define a smooth tangent.');
    node.handleIn = multiply(direction, -Math.max(1, distance(node.point, previous.point) / 3) / directionLength);
    node.handleOut = multiply(direction, Math.max(1, distance(node.point, next.point) / 3) / directionLength);
  }
  return serializePath(path);
}

function curvePoints(path: EditablePath, segmentIndex: number): [Point, Point, Point, Point, number] {
  const fromIndex = segmentIndex;
  const toIndex = segmentIndex + 1 < path.nodes.length ? segmentIndex + 1 : path.closed && segmentIndex === path.nodes.length - 1 ? 0 : -1;
  if (fromIndex < 0 || fromIndex >= path.nodes.length || toIndex < 0) throw new Error(`Path segment ${segmentIndex} does not exist.`);
  const from = path.nodes[fromIndex]; const to = path.nodes[toIndex];
  return [from.point, add(from.point, from.handleOut), add(to.point, to.handleIn), to.point, toIndex];
}

export function insertPathNode(pathData: string, segmentIndex: number, time = 0.5): string {
  if (!Number.isFinite(time) || time <= 0 || time >= 1) throw new Error('Path insertion time must be greater than 0 and less than 1.');
  const path = parsePath(pathData); const [p0, p1, p2, p3, toIndex] = curvePoints(path, segmentIndex);
  const q0 = lerp(p0, p1, time); const q1 = lerp(p1, p2, time); const q2 = lerp(p2, p3, time);
  const r0 = lerp(q0, q1, time); const r1 = lerp(q1, q2, time); const split = lerp(r0, r1, time);
  path.nodes[segmentIndex].handleOut = subtract(q0, p0);
  path.nodes[toIndex].handleIn = subtract(q2, p3);
  const inserted: EditableNode = { point: split, handleIn: subtract(r0, split), handleOut: subtract(r1, split) };
  if (toIndex === 0) path.nodes.push(inserted); else path.nodes.splice(toIndex, 0, inserted);
  return serializePath(path);
}

export function deletePathNode(pathData: string, nodeIndex: number): string {
  const path = parsePath(pathData); const minimum = path.closed ? 3 : 2;
  if (path.nodes.length <= minimum) throw new Error(`A ${path.closed ? 'closed' : 'open'} path must retain at least ${minimum} nodes.`);
  if (!path.nodes[nodeIndex]) throw new Error(`Path node ${nodeIndex} does not exist.`);
  path.nodes.splice(nodeIndex, 1); return serializePath(path);
}

export function setPathClosed(pathData: string, closed: boolean): string {
  const path = parsePath(pathData); path.closed = closed; return serializePath(path);
}

/**
 * Cuts an open path into two paths at an interior anchor. Cutting a closed path
 * opens it at the selected anchor while preserving the former closing segment.
 */
export function splitPathAtNode(pathData: string, nodeIndex: number): SplitPathResult {
  const path = parsePath(pathData);
  const node = path.nodes[nodeIndex];
  if (!node) throw new Error(`Path node ${nodeIndex} does not exist.`);

  if (path.closed) {
    const ordered = [
      ...path.nodes.slice(nodeIndex),
      ...path.nodes.slice(0, nodeIndex),
    ].map((entry) => ({
      point: clonePoint(entry.point),
      handleIn: clonePoint(entry.handleIn),
      handleOut: clonePoint(entry.handleOut),
    }));
    const first = ordered[0];
    ordered.push({
      point: clonePoint(first.point),
      handleIn: clonePoint(first.handleIn),
      handleOut: zero(),
    });
    first.handleIn = zero();
    return { primaryPathData: serializePath({ nodes: ordered, closed: false }) };
  }

  if (nodeIndex <= 0 || nodeIndex >= path.nodes.length - 1) {
    throw new Error('An open path can only be split at an interior node.');
  }
  const primaryNodes = path.nodes.slice(0, nodeIndex + 1).map((entry) => structuredClone(entry));
  const secondaryNodes = path.nodes.slice(nodeIndex).map((entry) => structuredClone(entry));
  primaryNodes.at(-1)!.handleOut = zero();
  secondaryNodes[0].handleIn = zero();
  return {
    primaryPathData: serializePath({ nodes: primaryNodes, closed: false }),
    secondaryPathData: serializePath({ nodes: secondaryNodes, closed: false }),
  };
}

/** Applies an affine transform to anchors and control points without flattening curves. */
export function transformPathData(pathData: string, matrix: PathAffineMatrix): string {
  const path = parsePath(pathData);
  path.nodes = path.nodes.map((node) => {
    const anchor = transformPoint(node.point, matrix);
    const handleIn = transformPoint(add(node.point, node.handleIn), matrix);
    const handleOut = transformPoint(add(node.point, node.handleOut), matrix);
    return {
      point: anchor,
      handleIn: subtract(handleIn, anchor),
      handleOut: subtract(handleOut, anchor),
    };
  });
  return serializePath(path);
}

/** Joins two open paths, orienting the selected endpoints toward one another. */
export function joinPathData(
  primaryPathData: string,
  secondaryPathData: string,
  primaryEndpoint: PathEndpoint = 'end',
  secondaryEndpoint: PathEndpoint = 'start',
): string {
  let primary = parsePath(primaryPathData);
  let secondary = parsePath(secondaryPathData);
  if (primary.closed || secondary.closed) throw new Error('Only open paths can be joined. Cut a closed path first.');
  if (primaryEndpoint === 'start') primary = reversePath(primary);
  if (secondaryEndpoint === 'end') secondary = reversePath(secondary);

  const primaryEnd = primary.nodes.at(-1)!;
  const secondaryStart = secondary.nodes[0];
  if (distance(primaryEnd.point, secondaryStart.point) <= EPSILON) {
    primaryEnd.handleOut = clonePoint(secondaryStart.handleOut);
    secondary.nodes.shift();
  } else {
    primaryEnd.handleOut = zero();
    secondaryStart.handleIn = zero();
  }
  return serializePath({ nodes: [...primary.nodes, ...secondary.nodes], closed: false });
}

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, time: number): Point {
  const inverse = 1 - time;
  return point(inverse ** 3 * p0.x + 3 * inverse ** 2 * time * p1.x + 3 * inverse * time ** 2 * p2.x + time ** 3 * p3.x, inverse ** 3 * p0.y + 3 * inverse ** 2 * time * p1.y + 3 * inverse * time ** 2 * p2.y + time ** 3 * p3.y);
}

export function nearestPathLocation(pathData: string, x: number, y: number): NearestPathLocation {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Path location coordinates must be finite.');
  const path = parsePath(pathData); const target = point(x, y); const segmentCount = path.closed ? path.nodes.length : path.nodes.length - 1;
  let best: NearestPathLocation = { segmentIndex: 0, time: 0, distance: Number.POSITIVE_INFINITY, point: clonePoint(path.nodes[0].point) };
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const [p0, p1, p2, p3] = curvePoints(path, segmentIndex);
    for (let sample = 0; sample <= 48; sample += 1) {
      const time = sample / 48; const candidate = cubicAt(p0, p1, p2, p3, time); const candidateDistance = distance(candidate, target);
      if (candidateDistance < best.distance) best = { segmentIndex, time, distance: candidateDistance, point: candidate };
    }
  }
  const [p0, p1, p2, p3] = curvePoints(path, best.segmentIndex); let left = Math.max(0, best.time - 1 / 48); let right = Math.min(1, best.time + 1 / 48);
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const oneThird = left + (right - left) / 3; const twoThirds = right - (right - left) / 3;
    if (distance(cubicAt(p0, p1, p2, p3, oneThird), target) <= distance(cubicAt(p0, p1, p2, p3, twoThirds), target)) right = twoThirds; else left = oneThird;
  }
  const time = (left + right) / 2; const nearest = cubicAt(p0, p1, p2, p3, time);
  return { segmentIndex: best.segmentIndex, time, distance: distance(nearest, target), point: nearest };
}
