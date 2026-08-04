import { describe, expect, it } from 'vitest';
import {
  CanvasOperationSchema,
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  TransactionConflictError,
  applyTransaction,
  createIllustrationDocument,
  illustrationAnimationSamples,
  illustrationAtTime,
  illustrationPlaybackTime,
  nowIso,
  type CanvasTransaction,
  type IllustrationKeyframe,
  type ShapeObject,
} from '@aidraw/core';

function fixture() {
  const document = createIllustrationDocument('Animated vector');
  const layerId = document.layerIds.find((id) => document.layers[id].type === 'vector')!;
  const timestamp = nowIso();
  const object: ShapeObject = {
    id: 'animated-shape', revision: 0, name: 'Animated shape', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: structuredClone(IDENTITY_TRANSFORM),
    type: 'shape', shape: 'rectangle', width: 40, height: 30, fill: { kind: 'solid', color: '#ff6b7a' },
    stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
  document.objects[object.id] = object;
  const layer = document.layers[layerId]; if (layer.type !== 'vector') throw new Error('Expected vector layer'); layer.objectIds.push(object.id);
  return { document, object };
}

function keyframe(id: string, timeMs: number, x: number, rotation = 0, easing: IllustrationKeyframe['easing'] = 'linear'): IllustrationKeyframe {
  const timestamp = nowIso();
  return {
    id, revision: 0, name: `${timeMs} ms`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    objectId: 'animated-shape', timeMs, transform: { ...IDENTITY_TRANSFORM, x, rotation }, opacity: timeMs ? 0.5 : 1, visible: true, easing,
  };
}

function transaction(documentId: string, operations: CanvasTransaction['operations']): CanvasTransaction {
  return { id: `tx-${Math.random()}`, clientOperationId: `op-${Math.random()}`, documentId, actor: HUMAN_ACTOR, label: 'Edit animation', createdAt: nowIso(), operations };
}

describe('illustration animation', () => {
  it('interpolates complete poses deterministically, including shortest-path rotation and easing', () => {
    const { document } = fixture();
    document.animation.keyframes = { first: keyframe('first', 0, 0, 350, 'ease-in-out'), last: keyframe('last', 1_000, 100, 10) };
    document.animation.keyframeIds = ['first', 'last'];
    const halfway = illustrationAtTime(document, 500).objects['animated-shape'];
    expect(halfway.transform.x).toBe(50);
    expect(halfway.transform.rotation).toBe(360);
    expect(halfway.opacity).toBe(0.75);
    expect(document.objects['animated-shape'].transform.x).toBe(0);
    document.animation.keyframes.first.easing = 'hold';
    expect(illustrationAtTime(document, 999).objects['animated-shape'].transform.x).toBe(0);
    expect(illustrationAtTime(document, 1_000).objects['animated-shape'].transform.x).toBe(100);
  });

  it('maps once, loop, and ping-pong playback and emits bounded export samples', () => {
    const animation = { durationMs: 1_000, framesPerSecond: 4, playback: 'once' as const, keyframeIds: [], keyframes: {} };
    expect(illustrationPlaybackTime(animation, 1_500)).toBe(1_000);
    expect(illustrationPlaybackTime({ ...animation, playback: 'loop' }, 1_250)).toBe(250);
    expect(illustrationPlaybackTime({ ...animation, playback: 'ping-pong' }, 1_250)).toBe(750);
    expect(illustrationAnimationSamples(animation).map((sample) => sample.timeMs)).toEqual([0, 250, 500, 750]);
    expect(illustrationAnimationSamples({ ...animation, playback: 'ping-pong' }).map((sample) => sample.timeMs)).toEqual([0, 250, 500, 750, 500, 250]);
    expect(() => illustrationAnimationSamples({ ...animation, framesPerSecond: 120 }, 10)).toThrow(/limit/);
  });

  it('upserts, replaces, deletes, conflicts, and restores keyframes through reducer inverses', () => {
    const { document } = fixture(); const first = keyframe('first', 0, 0);
    const added = applyTransaction(document, transaction(document.id, [{ kind: 'illustration.animation.keyframe.upsert', keyframe: first }]));
    if (added.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(added.document.animation.keyframeIds).toEqual(['first']);
    const editedFrame = { ...added.document.animation.keyframes.first, transform: { ...IDENTITY_TRANSFORM, x: 24 } };
    const edited = applyTransaction(added.document, transaction(document.id, [{ kind: 'illustration.animation.keyframe.upsert', keyframe: editedFrame, expectedRevision: 0 }]));
    if (edited.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(edited.document.animation.keyframes.first).toMatchObject({ revision: 1, transform: { x: 24 } });
    expect(() => applyTransaction(edited.document, transaction(document.id, [{ kind: 'illustration.animation.keyframe.upsert', keyframe: editedFrame, expectedRevision: 0 }]))).toThrow(TransactionConflictError);
    const removed = applyTransaction(edited.document, transaction(document.id, [{ kind: 'illustration.animation.keyframe.delete', keyframeId: 'first', expectedRevision: 1 }]));
    if (removed.document.kind !== 'illustration') throw new Error('Expected illustration'); expect(removed.document.animation.keyframeIds).toEqual([]);
    const restored = applyTransaction(removed.document, removed.inverse).document;
    if (restored.kind !== 'illustration') throw new Error('Expected illustration'); expect(restored.animation.keyframes.first.transform.x).toBe(24);
  });

  it('strictly validates animation operations and rejects duplicate object times', () => {
    const valid = { kind: 'illustration.animation.keyframe.upsert', keyframe: keyframe('first', 0, 0) };
    expect(CanvasOperationSchema.safeParse(valid).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({ ...valid, surprise: true }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ ...valid, keyframe: { ...valid.keyframe, opacity: 2 } }).success).toBe(false);
    const { document } = fixture(); document.animation.keyframes.first = valid.keyframe; document.animation.keyframeIds = ['first'];
    expect(() => applyTransaction(document, transaction(document.id, [{ kind: 'illustration.animation.keyframe.upsert', keyframe: keyframe('second', 0, 20) }]))).toThrow(/already has a keyframe/);
  });
});
