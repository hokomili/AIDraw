import { describe, expect, it } from 'vitest';
import { DEFAULT_ONION_SKIN_SETTINGS, MAX_ONION_SKIN_FRAMES_PER_SIDE, onionSkinLayers } from '../../src/common/onion-skin';

describe('onion skin layer planning', () => {
  it('orders farther frames before nearer frames and attenuates each side independently', () => {
    expect(onionSkinLayers(['f0', 'f1', 'f2', 'f3', 'f4'], 'f2', { ...DEFAULT_ONION_SKIN_SETTINGS, previousFrames: 2, nextFrames: 2 })).toEqual([
      { frameId: 'f0', side: 'previous', distance: 2, opacity: 0.11, tint: '#51bfc0' },
      { frameId: 'f4', side: 'next', distance: 2, opacity: 0.09, tint: '#ef7297' },
      { frameId: 'f1', side: 'previous', distance: 1, opacity: 0.22, tint: '#51bfc0' },
      { frameId: 'f3', side: 'next', distance: 1, opacity: 0.18, tint: '#ef7297' },
    ]);
  });

  it('clips at timeline edges, allows either side to be disabled, and returns no plan for an absent active frame', () => {
    const settings = { ...DEFAULT_ONION_SKIN_SETTINGS, previousFrames: 0, nextFrames: MAX_ONION_SKIN_FRAMES_PER_SIDE, nextOpacity: 0.4, nextTint: '#123456' };
    expect(onionSkinLayers(['a', 'b', 'c'], 'a', settings)).toEqual([
      { frameId: 'c', side: 'next', distance: 2, opacity: 0.2, tint: '#123456' },
      { frameId: 'b', side: 'next', distance: 1, opacity: 0.4, tint: '#123456' },
    ]);
    expect(onionSkinLayers(['0', '1', '2', '3', '4', '5', '6', '7', '8'], '4', { ...DEFAULT_ONION_SKIN_SETTINGS, previousFrames: 4, nextFrames: 4 })).toHaveLength(8);
    expect(onionSkinLayers(['a'], 'missing', settings)).toEqual([]);
  });

  it('rejects unbounded counts, invalid opacity, and non-RGB tints', () => {
    expect(() => onionSkinLayers(['a'], 'a', { ...DEFAULT_ONION_SKIN_SETTINGS, previousFrames: 5 })).toThrow(/0 through 4/);
    expect(() => onionSkinLayers(['a'], 'a', { ...DEFAULT_ONION_SKIN_SETTINGS, nextOpacity: Number.NaN })).toThrow(/between 0 and 1/);
    expect(() => onionSkinLayers(['a'], 'a', { ...DEFAULT_ONION_SKIN_SETTINGS, previousTint: '#fff' })).toThrow(/six-digit/);
  });
});
