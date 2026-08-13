export interface GridCheckerRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridCheckerPlan {
  visible?: GridCheckerRectangle;
  shadowSource?: GridCheckerRectangle;
  columnStart: number;
  columnEnd: number;
  rowStart: number;
  rowEnd: number;
}

export interface GridCheckerDrawingContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  rect(x: number, y: number, width: number, height: number): void;
  clip(): void;
  fill(): void;
}

export interface GridCheckerDrawResult extends GridCheckerPlan {
  darkCellCount: number;
}

export const GRID_CHECKER_SHADOW_BLUR = 24;
export const GRID_CHECKER_SHADOW_OFFSET_Y = 8;
export const GRID_CHECKER_SHADOW_PADDING = 64;

function finitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive and finite.`);
}

function intersection(
  surfaceWidth: number,
  surfaceHeight: number,
  rectangle: GridCheckerRectangle,
): GridCheckerRectangle | undefined {
  const right = rectangle.x + rectangle.width;
  const bottom = rectangle.y + rectangle.height;
  if (![right, bottom].every(Number.isFinite)) throw new RangeError('Grid checker viewport exceeds finite coordinates.');
  const x = Math.max(0, rectangle.x);
  const y = Math.max(0, rectangle.y);
  const clippedRight = Math.min(surfaceWidth, right);
  const clippedBottom = Math.min(surfaceHeight, bottom);
  return clippedRight > x && clippedBottom > y
    ? { x, y, width: clippedRight - x, height: clippedBottom - y }
    : undefined;
}

/**
 * Plans only the checker cells and shadow source that can reach one viewport.
 * Checker indexes remain anchored to the complete surface so panning cannot
 * rephase transparency. The shadow source carries bounded overscan, keeping
 * its artificial edges outside the current 24 px blur plus 8 px offset.
 */
export function planGridChecker(
  surfaceWidth: number,
  surfaceHeight: number,
  cellSize: number,
  viewport: GridCheckerRectangle,
  shadowPadding = GRID_CHECKER_SHADOW_PADDING,
): GridCheckerPlan {
  finitePositive(surfaceWidth, 'Grid checker width');
  finitePositive(surfaceHeight, 'Grid checker height');
  finitePositive(cellSize, 'Grid checker cell size');
  finitePositive(viewport.width, 'Grid checker viewport width');
  finitePositive(viewport.height, 'Grid checker viewport height');
  if (![viewport.x, viewport.y].every(Number.isFinite)) throw new RangeError('Grid checker viewport offsets must be finite.');
  if (!Number.isFinite(shadowPadding) || shadowPadding < 0) throw new RangeError('Grid checker shadow padding must be finite and nonnegative.');

  const visible = intersection(surfaceWidth, surfaceHeight, viewport);
  const shadowViewport = {
    x: viewport.x - shadowPadding,
    y: viewport.y - shadowPadding,
    width: viewport.width + shadowPadding * 2,
    height: viewport.height + shadowPadding * 2,
  };
  if (![shadowViewport.x, shadowViewport.y, shadowViewport.width, shadowViewport.height].every(Number.isFinite)) {
    throw new RangeError('Grid checker shadow viewport exceeds finite coordinates.');
  }
  const shadowSource = intersection(surfaceWidth, surfaceHeight, shadowViewport);
  if (!visible) return { visible, shadowSource, columnStart: 0, columnEnd: 0, rowStart: 0, rowEnd: 0 };

  const columnStart = Math.max(0, Math.floor(visible.x / cellSize));
  const columnEnd = Math.min(Math.ceil(surfaceWidth / cellSize), Math.ceil((visible.x + visible.width) / cellSize));
  const rowStart = Math.max(0, Math.floor(visible.y / cellSize));
  const rowEnd = Math.min(Math.ceil(surfaceHeight / cellSize), Math.ceil((visible.y + visible.height) / cellSize));
  if (![columnStart, columnEnd, rowStart, rowEnd].every(Number.isSafeInteger)) {
    throw new RangeError('Grid checker cell range exceeds safe indexes.');
  }
  return { visible, shadowSource, columnStart, columnEnd, rowStart, rowEnd };
}

/** Draws one bounded checker surface with one shadowed source rectangle. */
export function drawBoundedGridChecker(
  context: GridCheckerDrawingContext,
  surfaceWidth: number,
  surfaceHeight: number,
  cellSize: number,
  viewport: GridCheckerRectangle,
): GridCheckerDrawResult {
  const plan = planGridChecker(surfaceWidth, surfaceHeight, cellSize, viewport);
  let darkCellCount = 0;
  if (!plan.shadowSource) return { ...plan, darkCellCount };

  context.save();
  context.fillStyle = '#f5f1eb';
  context.shadowColor = 'rgba(47, 39, 63, .2)';
  context.shadowBlur = GRID_CHECKER_SHADOW_BLUR;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = GRID_CHECKER_SHADOW_OFFSET_Y;
  context.fillRect(plan.shadowSource.x, plan.shadowSource.y, plan.shadowSource.width, plan.shadowSource.height);

  if (plan.visible) {
    context.shadowColor = 'transparent';
    context.shadowBlur = 0;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.beginPath();
    context.rect(plan.visible.x, plan.visible.y, plan.visible.width, plan.visible.height);
    context.clip();
    context.fillStyle = '#e5e0d9';
    context.beginPath();
    for (let row = plan.rowStart; row < plan.rowEnd; row += 1) {
      for (let column = plan.columnStart; column < plan.columnEnd; column += 1) {
        if ((column + row) % 2 !== 0) continue;
        context.rect(column * cellSize, row * cellSize, cellSize, cellSize);
        darkCellCount += 1;
      }
    }
    if (darkCellCount) context.fill();
  }
  context.restore();
  return { ...plan, darkCellCount };
}
