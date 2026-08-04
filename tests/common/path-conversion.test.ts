import { describe, expect, it } from 'vitest';
import { convertPathArcsToCubics } from '../../src/common/path-conversion';
import { inspectPathNodes } from '../../src/common/path-nodes';

describe('path conversion', () => {
  it('converts SVG elliptical arcs into semantically editable cubic nodes', () => { const converted = convertPathArcsToCubics('M 0 0 A 20 10 30 0 1 40 20'); expect(converted.pathData).not.toMatch(/[aA]/); expect(inspectPathNodes(converted.pathData)).toHaveLength(3); expect(converted.closed).toBe(false); });
  it('preserves a closed path', () => { const converted = convertPathArcsToCubics('M 0 0 A 20 20 0 0 1 40 0 L 0 0 Z'); expect(converted.closed).toBe(true); expect(converted.pathData.trim()).toMatch(/[zZ]$/); });
  it('rejects compound paths rather than silently dropping subpaths', () => { expect(() => convertPathArcsToCubics('M0 0 L10 0 M20 0 L30 0')).toThrow(/one simple subpath/); });
});
