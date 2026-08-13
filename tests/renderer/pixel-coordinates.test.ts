import { describe, expect, it } from 'vitest';
import { clientPointToIsometricCoordinate, clientPointToIsometricTile, clientPointToPixel } from '../../src/renderer/canvas/pixel-coordinates';

describe('pixel canvas pointer coordinates', () => {
  it('maps through a CSS-stretched canvas without shifting the target pixel', () => {
    const logicalSize = { width: 800, height: 600 };
    const bounds = { left: 100, top: 40, width: 800, height: 692 };
    const view = { scale: 8, offsetX: 144, offsetY: 44 };
    const target = { x: 20, y: 30 };
    const canvasX = view.offsetX + (target.x + 0.5) * view.scale;
    const canvasY = view.offsetY + (target.y + 0.5) * view.scale;

    expect(clientPointToPixel(
      bounds.left + canvasX * bounds.width / logicalSize.width,
      bounds.top + canvasY * bounds.height / logicalSize.height,
      bounds,
      logicalSize,
      view,
    )).toEqual(target);
  });

  it('stays exact at low zoom with fractional screen bounds', () => {
    const logicalSize = { width: 1000, height: 700 };
    const bounds = { left: 23.25, top: 17.5, width: 999.5, height: 699.75 };
    const view = { scale: 2, offsetX: 311, offsetY: 241 };
    const target = { x: 97, y: 42 };
    const canvasX = view.offsetX + (target.x + 0.25) * view.scale;
    const canvasY = view.offsetY + (target.y + 0.75) * view.scale;

    expect(clientPointToPixel(
      bounds.left + canvasX * bounds.width / logicalSize.width,
      bounds.top + canvasY * bounds.height / logicalSize.height,
      bounds,
      logicalSize,
      view,
    )).toEqual(target);
  });

  it('inverts an asymmetric isometric diamond projection after CSS scaling', () => {
    const logicalSize = { width: 900, height: 640 }; const bounds = { left: 31, top: 19, width: 1200, height: 800 }; const view = { scale: 32, offsetX: 70, offsetY: 45 }; const mapHeight = 13; const cellHeight = 12; const target = { x: 7, y: 11 };
    const canvasX = view.offsetX + (target.x - target.y + mapHeight) * view.scale / 2;
    const canvasY = view.offsetY + (target.x + target.y + 1) * cellHeight / 2;
    expect(clientPointToIsometricTile(bounds.left + canvasX * bounds.width / logicalSize.width, bounds.top + canvasY * bounds.height / logicalSize.height, bounds, logicalSize, view, mapHeight, cellHeight)).toEqual(target);
  });

  it('preserves fractional isometric coordinates and a non-2:1 cell ratio for object gestures', () => {
    const logicalSize = { width: 900, height: 640 }; const bounds = { left: 31, top: 19, width: 1200, height: 800 }; const view = { scale: 32, offsetX: 70, offsetY: 45 }; const mapHeight = 13; const cellHeight = 12; const target = { x: 7.25, y: 11.75 };
    const canvasX = view.offsetX + (target.x - target.y + mapHeight) * view.scale / 2; const canvasY = view.offsetY + (target.x + target.y) * cellHeight / 2;
    expect(clientPointToIsometricCoordinate(bounds.left + canvasX * bounds.width / logicalSize.width, bounds.top + canvasY * bounds.height / logicalSize.height, bounds, logicalSize, view, mapHeight, cellHeight)).toEqual(target);
  });
});
