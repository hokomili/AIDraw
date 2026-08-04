import { describe, expect, it } from 'vitest';
import {
  convertPathNode,
  deletePathNode,
  inspectPathNodes,
  insertPathNode,
  joinPathData,
  movePathPoint,
  nearestPathLocation,
  setPathClosed,
  splitPathAtNode,
  transformPathData,
} from '../../src/common/path-nodes';

const CURVE = 'M 0 0 C 20 0 20 20 40 20 C 60 20 60 0 80 0';

describe('semantic Bézier path nodes', () => {
  it('distinguishes anchors from their incoming and outgoing handles', () => {
    const nodes = inspectPathNodes(CURVE);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({ anchor: { x: 0, y: 0 }, handleOut: { x: 20, y: 0 }, hasHandleOut: true });
    expect(nodes[1]).toMatchObject({ anchor: { x: 40, y: 20 }, handleIn: { x: 20, y: 20 }, handleOut: { x: 60, y: 20 }, kind: 'smooth' });
    expect(nodes[2]).toMatchObject({ anchor: { x: 80, y: 0 }, handleIn: { x: 60, y: 0 }, hasHandleIn: true });
  });

  it('moves an anchor with its handles and can mirror a dragged handle', () => {
    const moved = inspectPathNodes(movePathPoint(CURVE, 1, 'anchor', 45, 25));
    expect(moved[1]).toMatchObject({ anchor: { x: 45, y: 25 }, handleIn: { x: 25, y: 25 }, handleOut: { x: 65, y: 25 } });
    const mirrored = inspectPathNodes(movePathPoint(CURVE, 1, 'out', 40, 40, true))[1];
    expect(mirrored.handleOut).toMatchObject({ x: 40, y: 40 });
    expect(mirrored.handleIn.x).toBeCloseTo(40);
    expect(mirrored.handleIn.y).toBeCloseTo(0);
    expect(mirrored.kind).toBe('smooth');
  });

  it('converts corner/smooth nodes and preserves a valid path', () => {
    const corner = inspectPathNodes(convertPathNode(CURVE, 1, 'corner'))[1];
    expect(corner).toMatchObject({ hasHandleIn: false, hasHandleOut: false, kind: 'corner' });
    const smooth = inspectPathNodes(convertPathNode(convertPathNode(CURVE, 1, 'corner'), 1, 'smooth'))[1];
    expect(smooth).toMatchObject({ hasHandleIn: true, hasHandleOut: true, kind: 'smooth' });
  });

  it('adds and deletes a node by true curve subdivision', () => {
    const inserted = insertPathNode(CURVE, 0, 0.5);
    const nodes = inspectPathNodes(inserted);
    expect(nodes).toHaveLength(4);
    expect(nodes[1].anchor.x).toBeCloseTo(20);
    expect(nodes[1].anchor.y).toBeCloseTo(10);
    expect(inspectPathNodes(deletePathNode(inserted, 1))).toHaveLength(3);
  });

  it('opens/closes paths and locates the nearest curve deterministically', () => {
    const closed = setPathClosed(CURVE, true);
    expect(closed.trim().endsWith('Z')).toBe(true);
    expect(setPathClosed(closed, false).trim().endsWith('Z')).toBe(false);
    const location = nearestPathLocation(CURVE, 20, 9);
    expect(location.segmentIndex).toBe(0);
    expect(location.distance).toBeLessThan(2);
    expect(location.time).toBeGreaterThan(0.4);
    expect(location.time).toBeLessThan(0.6);
  });

  it('splits open paths at an interior node and opens closed paths at any node', () => {
    const open = splitPathAtNode('M 0 0 C 4 0 6 0 10 0 L 20 0', 1);
    expect(inspectPathNodes(open.primaryPathData)).toHaveLength(2);
    expect(inspectPathNodes(open.secondaryPathData!)).toHaveLength(2);
    expect(inspectPathNodes(open.primaryPathData).at(-1)?.anchor).toEqual({ x: 10, y: 0 });
    expect(inspectPathNodes(open.secondaryPathData!).at(0)?.anchor).toEqual({ x: 10, y: 0 });

    const closed = splitPathAtNode('M 0 0 L 10 0 L 10 10 Z', 1);
    const openedNodes = inspectPathNodes(closed.primaryPathData);
    expect(closed.secondaryPathData).toBeUndefined();
    expect(openedNodes).toHaveLength(4);
    expect(openedNodes[0].anchor).toEqual(openedNodes.at(-1)?.anchor);
    expect(closed.primaryPathData).not.toMatch(/[zZ]/);
  });

  it('joins selected endpoints and keeps affine-transformed curve handles editable', () => {
    const joined = joinPathData('M 0 0 L 10 0', 'M 20 0 L 30 0', 'end', 'start');
    expect(inspectPathNodes(joined).map((node) => node.anchor.x)).toEqual([0, 10, 20, 30]);
    const transformed = transformPathData('M 0 0 C 2 0 8 0 10 0', { a: 2, b: 0, c: 0, d: 3, e: 5, f: 7 });
    const nodes = inspectPathNodes(transformed);
    expect(nodes[0]).toMatchObject({ anchor: { x: 5, y: 7 }, handleOut: { x: 9, y: 7 } });
    expect(nodes[1]).toMatchObject({ anchor: { x: 25, y: 7 }, handleIn: { x: 21, y: 7 } });
  });

  it('rejects invalid indexes and deleting below the minimum node count', () => {
    expect(() => movePathPoint(CURVE, 99, 'anchor', 0, 0)).toThrow(/does not exist/);
    expect(() => deletePathNode('M 0 0 L 10 10', 0)).toThrow(/retain at least 2/);
    expect(() => insertPathNode(CURVE, 0, 1)).toThrow(/greater than 0/);
  });
});
