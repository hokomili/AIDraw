import { describe, expect, it } from 'vitest';
import {
  createPixelDocument,
  deletePixelAnimationTag,
  duplicatePixelFrame,
  pixelAnimationFrames,
  pixelCelForFrame,
  readPixel,
  reorderPixelFrame,
  resolvePixelCel,
  setPixelFrameCelsLinked,
  setPixelFramePaletteOverride,
  upsertPixelAnimationTag,
  writePixels,
  type DuplicatedPixelFrame,
  type PixelSprite,
} from '@aidraw/core';

function spriteFixture(): PixelSprite {
  const document = createPixelDocument('sprite');
  const sprite = document.pixelAssets[document.activeAssetId];
  if (sprite.type !== 'sprite') throw new Error('Expected sprite');
  return sprite;
}

function installFrame(sprite: PixelSprite, duplicate: DuplicatedPixelFrame): void {
  sprite.frames[duplicate.frame.id] = duplicate.frame;
  sprite.frameIds.splice(duplicate.index, 0, duplicate.frame.id);
  for (const cel of duplicate.cels) sprite.cels[cel.id] = cel;
}

function deterministicIds(...ids: string[]) {
  let index = 0;
  return () => ids[index++] ?? `generated-${index}`;
}

describe('pixel animation kernel', () => {
  it('duplicates resolved pixels and links or unlinks cels without losing indexed content', () => {
    const sprite = spriteFixture();
    const layerId = sprite.layerIds[0];
    const firstFrameId = sprite.frameIds[0];
    const firstCel = pixelCelForFrame(sprite, layerId, firstFrameId)!;
    writePixels(firstCel, [{ x: 3, y: 4, index: 5 }]);

    const duplicate = duplicatePixelFrame(sprite, firstFrameId, {
      actorId: 'agent-animation', timestamp: '2026-08-04T00:00:00.000Z', createId: deterministicIds('frame-two', 'cel-two'),
    });
    installFrame(sprite, duplicate);
    expect(readPixel(pixelCelForFrame(sprite, layerId, 'frame-two')!, 3, 4)).toBe(5);

    const linked = setPixelFrameCelsLinked(sprite, 'frame-two', true);
    const rawLinked = Object.values(linked.cels).find((cel) => cel.frameId === 'frame-two')!;
    expect(rawLinked.linkedToCelId).toBe(firstCel.id);
    expect(rawLinked.chunks).toEqual({});
    writePixels(linked.cels[firstCel.id], [{ x: 3, y: 4, index: 7 }]);
    expect(readPixel(pixelCelForFrame(linked, layerId, 'frame-two')!, 3, 4)).toBe(7);

    const unlinked = setPixelFrameCelsLinked(linked, 'frame-two', false);
    const rawUnlinked = Object.values(unlinked.cels).find((cel) => cel.frameId === 'frame-two')!;
    expect(rawUnlinked.linkedToCelId).toBeUndefined();
    writePixels(unlinked.cels[firstCel.id], [{ x: 3, y: 4, index: 2 }]);
    expect(readPixel(rawUnlinked, 3, 4)).toBe(7);
  });

  it('keeps tag ranges ordered when frames move and exposes the exact tagged sequence', () => {
    const sprite = spriteFixture();
    const first = sprite.frameIds[0];
    const duplicate = duplicatePixelFrame(sprite, first, {
      actorId: 'agent-animation', timestamp: '2026-08-04T00:00:00.000Z', createId: deterministicIds('frame-two', 'cel-two'),
    });
    installFrame(sprite, duplicate);
    const tagged = upsertPixelAnimationTag(sprite, { id: 'walk', name: ' Walk ', fromFrameId: first, toFrameId: 'frame-two', direction: 'ping-pong', color: '#31a6a0' });
    const moved = reorderPixelFrame(tagged, first, 1);
    expect(moved.frameIds).toEqual(['frame-two', first]);
    expect(moved.tags[0]).toMatchObject({ name: 'Walk', fromFrameId: 'frame-two', toFrameId: first });
    expect(pixelAnimationFrames(moved, 'walk')).toEqual(['frame-two', first]);
    expect(() => reorderPixelFrame(moved, first, 1)).toThrow(/edge/);
  });

  it('upserts and deletes tags and frame palettes without mutating the source sprite', () => {
    const sprite = spriteFixture();
    const frameId = sprite.frameIds[0];
    const tag = { id: 'idle', name: 'Idle', fromFrameId: frameId, toFrameId: frameId, direction: 'forward' as const, color: '#123456' };
    const tagged = upsertPixelAnimationTag(sprite, tag);
    const edited = upsertPixelAnimationTag(tagged, { ...tag, name: 'Idle blink', direction: 'reverse' });
    expect(sprite.tags).toHaveLength(0);
    expect(edited.tags).toEqual([{ ...tag, name: 'Idle blink', direction: 'reverse' }]);
    expect(deletePixelAnimationTag(edited, tag.id).tags).toEqual([]);

    const palette = [{ id: 'transparent', name: 'Transparent', color: '#00000000' }, { id: 'ink', name: 'Ink', color: '#123456' }];
    const overridden = setPixelFramePaletteOverride(sprite, frameId, palette);
    palette[1].color = '#ffffff';
    expect(overridden.paletteOverrides[frameId][1].color).toBe('#123456');
    expect(setPixelFramePaletteOverride(overridden, frameId).paletteOverrides[frameId]).toBeUndefined();
  });

  it('rejects malformed ranges, first-frame links, missing references, and link cycles', () => {
    const sprite = spriteFixture();
    const frameId = sprite.frameIds[0];
    expect(() => setPixelFrameCelsLinked(sprite, frameId, true)).toThrow(/first frame/);
    expect(() => upsertPixelAnimationTag(sprite, { id: 'bad', name: 'Bad', fromFrameId: 'missing', toFrameId: frameId, direction: 'forward', color: '#123456' })).toThrow(/range/);
    expect(() => setPixelFramePaletteOverride(sprite, 'missing', [])).toThrow(/does not exist/);
    const cel = Object.values(sprite.cels)[0];
    cel.linkedToCelId = cel.id;
    expect(resolvePixelCel(sprite, cel.id)).toBeUndefined();
  });
});
