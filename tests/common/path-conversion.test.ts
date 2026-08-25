import { describe, expect, it } from 'vitest';
import { inspectEditableSvgPathData, MAX_EDITABLE_SVG_PATH_NODES } from '@aidraw/core';
import { convertPathArcsToCubics, inspectNativeEditableSvgPathData } from '../../src/common/path-conversion';
import { inspectPathNodes, movePathPoint } from '../../src/common/path-nodes';

describe('path conversion', () => {
  it('converts SVG elliptical arcs into semantically editable cubic nodes', () => { const converted = convertPathArcsToCubics('M 0 0 A 20 10 30 0 1 40 20'); expect(converted.pathData).not.toMatch(/[aA]/); expect(inspectPathNodes(converted.pathData)).toHaveLength(3); expect(converted.closed).toBe(false); });
  it.each(['M0 0 A20 10 30 0140 20', 'M0 0 A20 10 30 01 40 20'])('converts every admitted compact arc-flag spelling: %s', (pathData) => {
    const converted = convertPathArcsToCubics(pathData);
    expect(converted.pathData).not.toMatch(/[aA]/);
    expect(inspectPathNodes(converted.pathData)).toHaveLength(3);
  });
  it('preserves a closed path', () => { const converted = convertPathArcsToCubics('M 0 0 A 20 20 0 0 1 40 0 L 0 0 Z'); expect(converted.closed).toBe(true); expect(converted.pathData.trim()).toMatch(/[zZ]$/); });
  it('rejects compound paths rather than silently dropping subpaths', () => { expect(() => convertPathArcsToCubics('M0 0 L10 0 M20 0 L30 0')).toThrow(/one simple subpath/); });
  it.each([
    'M0 0 L0 0 Z',
    'M0 0 L0.00000001 0 Z',
    'M0 0 C1 1 2 2 0 0 Z',
    'M0 0 A10 10 0 0 1 0 0',
    // Paper.js omits this non-zero but sub-tolerance arc; exact native
    // validation must still reject it after the grammar-level lower bound.
    'M0 0 A10 10 0 0 1 0.000001 0',
    'M0 0 A1 1000 0 0 0 0 0.00001',
  ])('rejects geometry that cannot retain two native nodes: %s', (pathData) => {
    expect(() => inspectNativeEditableSvgPathData(pathData)).toThrow(/effective native nodes|native node editing|native conversion/);
  });
  it('binds compact arc admission to its exact effective native node count', () => {
    expect(inspectNativeEditableSvgPathData('M0 0 A20 10 30 0140 20')).toMatchObject({ hasArc: true, effectiveNodeCount: 3 });
    expect(inspectNativeEditableSvgPathData('M0 0 A10 10 0 0 1 0.000002 0')).toMatchObject({ hasArc: true, effectiveNodeCount: 2 });
    expect(inspectNativeEditableSvgPathData('M0 0 A1 1000 0 0 0 0 0.001')).toMatchObject({ hasArc: true, effectiveNodeCount: 2 });
  });
  it('keeps core admission a conservative subset of native conversion across eccentric arc controls', () => {
    const failures: string[] = [];
    for (const origin of [0, 1_000_000_000]) for (const rx of [0, 1e-12, 1e-6, 1, 1_000]) for (const ry of [0, 1e-12, 1e-6, 1, 1_000]) {
      for (const chord of [2e-6, 1e-5, 1e-3]) for (const rotation of [0, 45]) for (const large of [0, 1]) for (const sweep of [0, 1]) {
        const pathData = `M${origin} ${origin} A${rx} ${ry} ${rotation} ${large} ${sweep} ${origin} ${origin + chord}`;
        try { inspectEditableSvgPathData(pathData); } catch { continue; }
        try { inspectNativeEditableSvgPathData(pathData); }
        catch { failures.push(pathData); }
      }
    }
    expect(failures).toEqual([]);
  });
  it('admits the exact node ceiling through the native node parser and rewrite path', () => {
    const pathData = `M0 0${' L1 1'.repeat(MAX_EDITABLE_SVG_PATH_NODES - 1)}`;
    expect(inspectEditableSvgPathData(pathData)).toMatchObject({ editableNodeUpperBound: MAX_EDITABLE_SVG_PATH_NODES });
    expect(inspectPathNodes(pathData)).toHaveLength(MAX_EDITABLE_SVG_PATH_NODES);
    const moved = movePathPoint(pathData, MAX_EDITABLE_SVG_PATH_NODES - 1, 'anchor', 2, 3);
    expect(inspectPathNodes(moved).at(-1)?.anchor).toEqual({ x: 2, y: 3 });
  });
});
