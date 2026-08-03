import { describe, expect, it } from 'vitest';
import type { PathObject } from '@aidraw/core';
import { approximateLocalObjectBounds } from '../../src/common/illustration-geometry';

describe('illustration geometry', () => {
  it('uses a curved path\'s coordinates instead of the legacy 100 px fallback', () => {
    const path = {
      type: 'path',
      pathData: 'M 176 568 C 248 308 569 137 889 260 L 923 473 C 727 384 516 345 276 641 Z',
      closed: true,
    } as PathObject;

    expect(approximateLocalObjectBounds(path)).toEqual({ x: 176, y: 137, width: 747, height: 504 });
  });
});
