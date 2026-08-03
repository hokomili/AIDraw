import { describe, expect, it } from 'vitest';
import type { CanvasOperation } from '@aidraw/core';
import { collectReplayMasks, replayPointKey, replayTileLayerKey } from '../../src/renderer/replay';

function replay(sourceOperations: CanvasOperation[], enabled = true) {
  return { replay: enabled, sourceOperations };
}

describe('durable trace replay masks', () => {
  it('conceals committed pixel and tile samples until they are revealed', () => {
    const masks = collectReplayMasks([replay([
      {
        kind: 'pixel.cel.set',
        spriteId: 'sprite-1',
        celId: 'cel-1',
        changes: [{ x: 2, y: 3, index: 4 }, { x: 5, y: 7, index: 8 }],
      },
      {
        kind: 'pixel.tilemap.set',
        mapId: 'map-1',
        layerId: 'layer-1',
        changes: [{ x: -1, y: 32, gid: 9 }],
      },
    ])]);

    expect(masks.celPixels.get('cel-1')).toEqual(new Set([replayPointKey(2, 3), replayPointKey(5, 7)]));
    expect(masks.tileCells.get(replayTileLayerKey('map-1', 'layer-1'))).toEqual(new Set([replayPointKey(-1, 32)]));
  });

  it('conceals committed illustration objects and paint strokes only for replays', () => {
    const object = {
      id: 'object-1', revision: 0, name: 'Ribbon', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'agent', layerId: 'layer-1', visible: true, locked: false, opacity: 1, blendMode: 'normal' as const,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
      type: 'vector-stroke' as const, points: [{ x: 0, y: 0, pressure: 0.5 }],
      brush: { size: 1, thinning: 0, smoothing: 0, streamline: 0, simulatePressure: false, color: '#000000' },
    };
    const stroke = {
      id: 'stroke-1', actorId: 'agent-1', points: [{ x: 0, y: 0, pressure: 0.5 }], preset: 'pencil' as const, size: 1,
      opacity: 1, flow: 1, spacing: 0.1, hardness: 1, color: '#000000', mode: 'paint' as const,
    };
    const operations: CanvasOperation[] = [
      { kind: 'illustration.object.add', object },
      { kind: 'illustration.paint.stroke', layerId: 'paint-1', stroke },
    ];

    const masks = collectReplayMasks([replay(operations), replay(operations, false)]);
    expect(masks.objectIds).toEqual(new Set(['object-1']));
    expect(masks.strokeIds).toEqual(new Set(['stroke-1']));
    expect(collectReplayMasks([replay(operations, false)]).objectIds.size).toBe(0);
  });
});
