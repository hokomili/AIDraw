import { describe, expect, it } from 'vitest';
import { IDENTITY_TRANSFORM, type PathObject } from '@aidraw/core';
import { inspectPathNodes } from '../../src/common/path-nodes';
import { joinPathObjects } from '../../src/common/path-topology';

function path(id: string, pathData: string, x = 0): PathObject {
  return {
    id,
    revision: 0,
    name: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'human',
    layerId: 'layer',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform: { ...IDENTITY_TRANSFORM, x },
    type: 'path',
    pathData,
    closed: false,
    fillRule: 'nonzero',
    fill: { kind: 'none' },
    stroke: { paint: { kind: 'solid', color: '#000000' }, width: 1, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
}

describe('path topology', () => {
  it('joins the nearest world-space endpoints while retaining the primary transform', () => {
    const primary = path('primary', 'M 0 0 L 10 0', 100);
    const secondary = path('secondary', 'M 0 0 L 10 0', 80);
    const joined = joinPathObjects(primary, secondary, 'nearest');
    expect(joined.transform).toEqual(primary.transform);
    expect(inspectPathNodes(joined.pathData).map((node) => node.anchor.x)).toEqual([10, 0, -10, -20]);
  });

  it('rejects closed paths instead of silently discarding a closing segment', () => {
    expect(() => joinPathObjects({ ...path('closed', 'M 0 0 L 10 0 L 10 10 Z'), closed: true }, path('open', 'M 20 0 L 30 0'))).toThrow(/Only open paths/);
  });
});
