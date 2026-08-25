const SVG_PATH_COMMAND = /^[AaCcHhLlMmQqSsTtVvZz]$/u;
const SVG_PATH_NUMBER_AT_CURSOR = /[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/uy;
const SVG_PATH_MAX_TOKENS = 1_000_000;
const SVG_PATH_MAX_ABSOLUTE_NUMBER = 1_000_000_000;
export const MAX_EDITABLE_SVG_PATH_CHARACTERS = 1_000_000;
/** Must stay identical to the native node parser's final-close coalescing bound. */
export const EDITABLE_SVG_PATH_CLOSE_EPSILON = 1e-7;
/** Conservative floor above the native converter's sub-two-micro-unit arc collapse. */
export const EDITABLE_SVG_PATH_NATIVE_ARC_CHORD = 2e-6;
/** Paper.js creates no cubic when an elliptical arc spans at most this many degrees. */
export const EDITABLE_SVG_PATH_NATIVE_ARC_EXTENT_EPSILON_DEGREES = 1e-5;

const PAPER_NUMERICAL_EPSILON = 1e-12;

const COMMAND_ARITY: Readonly<Record<string, number>> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
};

export interface SvgPathInspection {
  /** Whether the final authored subpath ends with an explicit close-path command. */
  closed: boolean;
  /** Number of explicit command tokens, including move and close commands. */
  commandCount: number;
  /** Number of parameterized drawing segments after expanding repeated parameter groups. */
  segmentCount: number;
  /** Number of explicit move-command families (one per authored subpath). */
  subpathCount: number;
  /** Conservative node count after every arc is converted to cubic segments. */
  editableNodeUpperBound: number;
  /** Conservative effective native nodes after arc segmentation and final-close coalescing. */
  effectiveNodeLowerBound: number;
  /** Whether at least one elliptical-arc segment is present. */
  hasArc: boolean;
}

// Node editing rewrites paths to explicit M/L/C segments. Seven thousand keeps
// the worst supported coordinate spelling and four-cubic arc expansion inside
// the shared one-million-character strict-mutation envelope.
export const MAX_EDITABLE_SVG_PATH_NODES = 7_000;

function isWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f';
}

function skipWhitespace(pathData: string, start: number): number {
  let cursor = start;
  while (isWhitespace(pathData[cursor])) cursor += 1;
  return cursor;
}

function consumeParameterSeparator(pathData: string, start: number): number {
  let cursor = skipWhitespace(pathData, start);
  if (pathData[cursor] !== ',') return cursor;
  cursor = skipWhitespace(pathData, cursor + 1);
  if (pathData[cursor] === ',' || cursor >= pathData.length || SVG_PATH_COMMAND.test(pathData[cursor] ?? '')) {
    throw new Error('SVG path commas may separate numeric parameters only and cannot be repeated.');
  }
  return cursor;
}

function parseNumber(pathData: string, start: number): { cursor: number; value: number; lexeme: string } {
  SVG_PATH_NUMBER_AT_CURSOR.lastIndex = start;
  const match = SVG_PATH_NUMBER_AT_CURSOR.exec(pathData);
  if (!match) throw new Error(`SVG path data contains an invalid number near character ${start}.`);
  const value = Number(match[0]);
  if (!Number.isFinite(value) || Math.abs(value) > SVG_PATH_MAX_ABSOLUTE_NUMBER) {
    throw new Error('SVG path numbers must be finite and no greater than 1,000,000,000 in magnitude.');
  }
  return { cursor: SVG_PATH_NUMBER_AT_CURSOR.lastIndex, value, lexeme: match[0] };
}

function parseArcFlag(pathData: string, start: number): { cursor: number; value: 0 | 1; lexeme: '0' | '1' } {
  const character = pathData[start];
  if (character !== '0' && character !== '1') throw new Error('SVG arc flags must be the literal character 0 or 1.');
  return { cursor: start + 1, value: character === '0' ? 0 : 1, lexeme: character };
}

function rotatePoint(x: number, y: number, degrees: number): { x: number; y: number } {
  if (degrees === 0) return { x, y };
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { x: x * cosine - y * sine, y: x * sine + y * cosine };
}

/**
 * Mirrors the finite-arithmetic elliptical-arc construction and segment-
 * admission rule used by the pinned Paper.js SVG path reader. This is
 * deliberately not a generic geometry approximation: strict
 * core callers and the main-owned Paper conversion must agree on whether every
 * admitted arc survives as editable native topology.
 */
function nativeArcCubicSegmentCount(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radiusX: number,
  radiusY: number,
  rotation: number,
  large: 0 | 1,
  sweep: 0 | 1,
): number {
  if (fromX === toX && fromY === toY) return 0;
  let rx = Math.abs(radiusX);
  let ry = Math.abs(radiusY);
  if (rx <= PAPER_NUMERICAL_EPSILON || ry <= PAPER_NUMERICAL_EPSILON) return 1;

  const middleX = (fromX + toX) / 2;
  const middleY = (fromY + toY) / 2;
  const local = rotatePoint(fromX - middleX, fromY - middleY, -rotation);
  const xSquared = local.x * local.x;
  const ySquared = local.y * local.y;
  let rxSquared = rx * rx;
  let rySquared = ry * ry;
  const radiusScale = Math.sqrt(xSquared / rxSquared + ySquared / rySquared);
  if (radiusScale > 1) {
    rx *= radiusScale;
    ry *= radiusScale;
    rxSquared = rx * rx;
    rySquared = ry * ry;
  }

  const denominator = rxSquared * ySquared + rySquared * xSquared;
  let factor = (rxSquared * rySquared - rxSquared * ySquared - rySquared * xSquared) / denominator;
  if (Math.abs(factor) < PAPER_NUMERICAL_EPSILON) factor = 0;
  if (!Number.isFinite(factor) || factor < 0) return 0;

  const centerScale = (large === sweep ? -1 : 1) * Math.sqrt(factor);
  const localCenterX = rx * local.y / ry * centerScale;
  const localCenterY = -ry * local.x / rx * centerScale;
  const rotatedCenter = rotatePoint(localCenterX, localCenterY, rotation);
  const centerX = rotatedCenter.x + middleX;
  const centerY = rotatedCenter.y + middleY;

  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const a = cosine * rx;
  const b = sine * rx;
  const c = -sine * ry;
  const d = cosine * ry;
  const determinant = a * d - b * c;
  if (!determinant || !Number.isFinite(determinant) || !Number.isFinite(centerX) || !Number.isFinite(centerY)) return 0;
  const inverse = (x: number, y: number) => {
    const translatedX = x - centerX;
    const translatedY = y - centerY;
    return {
      x: (translatedX * d - translatedY * c) / determinant,
      y: (translatedY * a - translatedX * b) / determinant,
    };
  };
  const from = inverse(fromX, fromY);
  const to = inverse(toX, toY);
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return 0;
  let extent = Math.atan2(from.x * to.y - from.y * to.x, from.x * to.x + from.y * to.y) * 180 / Math.PI;
  if (!sweep && extent > 0) extent -= 360;
  else if (sweep && extent < 0) extent += 360;
  const absoluteExtent = Math.abs(extent);
  if (!absoluteExtent) return 0;
  const count = absoluteExtent >= 360
    ? 4
    : Math.ceil((absoluteExtent - EDITABLE_SVG_PATH_NATIVE_ARC_EXTENT_EPSILON_DEGREES) / 90);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/**
 * Validates the complete SVG 2 path command grammar used by Canvas and SVG export.
 * Arc flags are parsed as one-character grammar terminals, so compact forms such
 * as `A1 2 0 013 4` remain valid while numeric lookalikes (`1e0`, `0.0`, `-0`)
 * fail closed. Geometry is neither flattened nor reinterpreted.
 */
function parseSvgPathData(pathData: string): SvgPathInspection & { normalizedPathData: string; commandAfterClose: boolean; nativeCollapsedArc: boolean } {
  if (typeof pathData !== 'string' || pathData.length < 1 || pathData.length > MAX_EDITABLE_SVG_PATH_CHARACTERS || !pathData.trim()) {
    throw new Error('Editable SVG path data must contain 1–1,000,000 characters.');
  }

  let cursor = skipWhitespace(pathData, 0);
  if (!/[Mm]/u.test(pathData[cursor] ?? '')) throw new Error('SVG path data must begin with a move command.');

  let commandCount = 0;
  let segmentCount = 0;
  let subpathCount = 0;
  let editableNodeUpperBound = 0;
  let effectiveNodeLowerBound = 0;
  let hasArc = false;
  let nativeCollapsedArc = false;
  let tokenCount = 0;
  let finalCommand = '';
  let commandAfterClose = false;
  let currentX = 0;
  let currentY = 0;
  let subpathStartX = 0;
  let subpathStartY = 0;
  let lastNodeX = 0;
  let lastNodeY = 0;
  let hasLastNode = false;
  const normalizedTokens: string[] = [];

  while (cursor < pathData.length) {
    cursor = skipWhitespace(pathData, cursor);
    if (cursor >= pathData.length) break;
    const command = pathData[cursor];
    if (!SVG_PATH_COMMAND.test(command)) throw new Error(`Every SVG path segment family must begin with a command near character ${cursor}.`);
    cursor += 1;
    normalizedTokens.push(command);
    commandCount += 1;
    tokenCount += 1;
    if (tokenCount > SVG_PATH_MAX_TOKENS) throw new Error('SVG path data exceeds the one-million-token validation limit.');
    const lower = command.toLowerCase();
    if (finalCommand === 'z') commandAfterClose = true;
    if (lower === 'm') subpathCount += 1;
    finalCommand = lower;

    cursor = skipWhitespace(pathData, cursor);
    if (pathData[cursor] === ',') throw new Error('SVG path commands cannot be followed by a comma.');
    if (lower === 'z') {
      if (effectiveNodeLowerBound > 1 && hasLastNode
        && Math.hypot(lastNodeX - subpathStartX, lastNodeY - subpathStartY) < EDITABLE_SVG_PATH_CLOSE_EPSILON) {
        effectiveNodeLowerBound -= 1;
      }
      currentX = subpathStartX;
      currentY = subpathStartY;
      continue;
    }

    const arity = COMMAND_ARITY[lower];
    if (!arity) throw new Error(`Unsupported SVG path command ${command}.`);
    let groups = 0;
    for (;;) {
      const probe = skipWhitespace(pathData, cursor);
      if (probe >= pathData.length || SVG_PATH_COMMAND.test(pathData[probe] ?? '')) {
        cursor = probe;
        if (groups === 0) throw new Error(`SVG path command ${command} has an incomplete parameter group.`);
        break;
      }

      const parameters: number[] = [];
      for (let position = 0; position < arity; position += 1) {
        if (groups > 0 || position > 0) cursor = consumeParameterSeparator(pathData, cursor);
        else cursor = skipWhitespace(pathData, cursor);
        if (cursor >= pathData.length || SVG_PATH_COMMAND.test(pathData[cursor] ?? '') || pathData[cursor] === ',') {
          throw new Error(`SVG path command ${command} has an incomplete parameter group.`);
        }

        const parsed = lower === 'a' && (position === 3 || position === 4)
          ? parseArcFlag(pathData, cursor)
          : parseNumber(pathData, cursor);
        cursor = parsed.cursor;
        parameters.push(parsed.value);
        normalizedTokens.push(parsed.lexeme);
        tokenCount += 1;
        if (tokenCount > SVG_PATH_MAX_TOKENS) throw new Error('SVG path data exceeds the one-million-token validation limit.');
        if (lower === 'a' && (position === 0 || position === 1) && parsed.value < 0) {
          throw new Error('SVG arc radii cannot be negative.');
        }
      }
      groups += 1;
      segmentCount += 1;
      const relative = command === lower;
      let targetX = currentX;
      let targetY = currentY;
      if (lower === 'h') targetX = relative ? currentX + parameters[0] : parameters[0];
      else if (lower === 'v') targetY = relative ? currentY + parameters[0] : parameters[0];
      else {
        const x = parameters[parameters.length - 2];
        const y = parameters[parameters.length - 1];
        targetX = relative ? currentX + x : x;
        targetY = relative ? currentY + y : y;
      }

      if (lower === 'm' && groups === 1) {
        subpathStartX = targetX;
        subpathStartY = targetY;
        effectiveNodeLowerBound += 1;
        hasLastNode = true;
        lastNodeX = targetX;
        lastNodeY = targetY;
      } else if (lower === 'a') {
        const chord = Math.hypot(targetX - currentX, targetY - currentY);
        const nativeSegments = chord >= EDITABLE_SVG_PATH_NATIVE_ARC_CHORD
          ? nativeArcCubicSegmentCount(
            currentX,
            currentY,
            targetX,
            targetY,
            parameters[0],
            parameters[1],
            parameters[2],
            parameters[3] as 0 | 1,
            parameters[4] as 0 | 1,
          )
          : 0;
        if (nativeSegments < 1) nativeCollapsedArc = true;
        else {
          effectiveNodeLowerBound += nativeSegments;
          hasLastNode = true;
          lastNodeX = targetX;
          lastNodeY = targetY;
        }
      } else {
        effectiveNodeLowerBound += 1;
        hasLastNode = true;
        lastNodeX = targetX;
        lastNodeY = targetY;
      }
      currentX = targetX;
      currentY = targetY;
      if (lower === 'a') {
        // One SVG elliptical arc spans at most one revolution. Paper.js may
        // represent it with at most four cubic segments, so reserve four nodes
        // before admitting it to the advertised arc-conversion/node workflow.
        editableNodeUpperBound += 4;
        hasArc = true;
      } else editableNodeUpperBound += 1;
    }
  }

  return {
    closed: finalCommand === 'z',
    commandCount,
    segmentCount,
    subpathCount,
    editableNodeUpperBound,
    effectiveNodeLowerBound,
    hasArc,
    nativeCollapsedArc,
    commandAfterClose,
    normalizedPathData: normalizedTokens.join(' '),
  };
}

export function inspectSvgPathData(pathData: string): SvgPathInspection {
  const parsed = parseSvgPathData(pathData);
  return {
    closed: parsed.closed,
    commandCount: parsed.commandCount,
    segmentCount: parsed.segmentCount,
    subpathCount: parsed.subpathCount,
    editableNodeUpperBound: parsed.editableNodeUpperBound,
    effectiveNodeLowerBound: parsed.effectiveNodeLowerBound,
    hasArc: parsed.hasArc,
  };
}

/**
 * Strict admission for newly authored or imported editable paths. The broad
 * SVG grammar above intentionally remains available for passive legacy reads;
 * new content must also fit every advertised node and arc-conversion workflow.
 */
export function inspectEditableSvgPathData(pathData: string): SvgPathInspection {
  const parsed = parseSvgPathData(pathData);
  if (parsed.subpathCount !== 1) {
    throw new Error('Editable SVG paths must contain exactly one simple subpath.');
  }
  if (parsed.commandAfterClose) {
    throw new Error('An editable SVG path close command must be its final command.');
  }
  if (parsed.nativeCollapsedArc) {
    throw new Error('Every editable SVG arc must survive native conversion as a distinct line or cubic segment.');
  }
  if (parsed.effectiveNodeLowerBound < 2) {
    throw new Error('Editable SVG paths must retain at least two effective native nodes after arc conversion and close coalescing.');
  }
  if (parsed.editableNodeUpperBound > MAX_EDITABLE_SVG_PATH_NODES) {
    throw new Error(`Editable SVG paths may contain at most ${MAX_EDITABLE_SVG_PATH_NODES.toLocaleString('en-US')} nodes after arc conversion.`);
  }
  return {
    closed: parsed.closed,
    commandCount: parsed.commandCount,
    segmentCount: parsed.segmentCount,
    subpathCount: parsed.subpathCount,
    editableNodeUpperBound: parsed.editableNodeUpperBound,
    effectiveNodeLowerBound: parsed.effectiveNodeLowerBound,
    hasArc: parsed.hasArc,
  };
}

/**
 * Produces a geometry-preserving, whitespace-separated spelling of every
 * admitted command and parameter. Consumers with less complete SVG tokenizers
 * (including Paper.js arc conversion) can therefore process compact arc flags
 * without narrowing AIDraw's renderer-compatible admission grammar.
 */
export function normalizeSvgPathData(pathData: string): string {
  return parseSvgPathData(pathData).normalizedPathData;
}
