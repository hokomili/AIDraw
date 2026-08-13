import { describe, expect, it } from 'vitest';
import { IDENTITY_TRANSFORM, type GroupObject, type PathObject } from '@aidraw/core';
import { approximateLocalObjectBounds, illustrationGroupRequiresIsolation, illustrationObjectHasTransform } from '../../src/common/illustration-geometry';

describe('illustration geometry', () => {
  it('uses a curved path\'s coordinates instead of the legacy 100 px fallback', () => {
    const path = {
      type: 'path',
      pathData: 'M 176 568 C 248 308 569 137 889 260 L 923 473 C 727 384 516 345 276 641 Z',
      closed: true,
    } as PathObject;

    expect(approximateLocalObjectBounds(path)).toEqual({ x: 176, y: 137, width: 747, height: 504 });
  });

  it('distinguishes transform-only group traversal from effect/composite isolation', () => {
    const group: GroupObject = {
      id: 'group', revision: 0, name: 'Group', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z', createdBy: 'human', layerId: 'layer',
      type: 'group', visible: true, locked: false, transform: structuredClone(IDENTITY_TRANSFORM), opacity: 1, blendMode: 'normal', childIds: [],
    };
    expect(illustrationObjectHasTransform(group)).toBe(false); expect(illustrationGroupRequiresIsolation(group)).toBe(false);
    group.transform = { ...group.transform, x: -20, y: -140, scaleX: 2, scaleY: 2 };
    expect(illustrationObjectHasTransform(group)).toBe(true); expect(illustrationGroupRequiresIsolation(group)).toBe(false);
    for (const changed of [
      { opacity: 0.5 }, { blendMode: 'multiply' as const }, { blur: 2 }, { filters: [{ type: 'brightness' as const, value: -1 }] },
      { maskObjectId: 'mask' }, { shadow: { color: '#000000', blur: 4, offsetX: 1, offsetY: 2 } },
    ]) expect(illustrationGroupRequiresIsolation({ ...group, ...changed })).toBe(true);
  });
});
