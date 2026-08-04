import { createId as defaultCreateId } from './ids';
import type {
  AnimationTag,
  Id,
  IllustrationAnimation,
  IllustrationDocument,
  IllustrationKeyframe,
  IllustrationObject,
  PaletteEntry,
  PixelCel,
  PixelFrame,
  PixelSprite,
  Transform,
} from './model';

export function defaultIllustrationAnimation(): IllustrationAnimation {
  return { durationMs: 2_000, framesPerSecond: 12, playback: 'loop', keyframeIds: [], keyframes: {} };
}

function lerp(from: number, to: number, progress: number): number { return from + (to - from) * progress; }

function lerpAngle(from: number, to: number, progress: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta * progress;
}

function ease(progress: number, easing: IllustrationKeyframe['easing']): number {
  if (easing === 'hold') return progress >= 1 ? 1 : 0;
  if (easing === 'ease-in-out') return progress * progress * (3 - 2 * progress);
  return progress;
}

function interpolateTransform(from: Transform, to: Transform, progress: number): Transform {
  return {
    x: lerp(from.x, to.x, progress), y: lerp(from.y, to.y, progress),
    scaleX: lerp(from.scaleX, to.scaleX, progress), scaleY: lerp(from.scaleY, to.scaleY, progress),
    rotation: lerpAngle(from.rotation, to.rotation, progress),
    skewX: lerp(from.skewX, to.skewX, progress), skewY: lerp(from.skewY, to.skewY, progress),
  };
}

export function illustrationKeyframesForObject(document: IllustrationDocument, objectId: Id): IllustrationKeyframe[] {
  return document.animation.keyframeIds
    .map((id) => document.animation.keyframes[id])
    .filter((keyframe): keyframe is IllustrationKeyframe => Boolean(keyframe) && keyframe.objectId === objectId)
    .sort((left, right) => left.timeMs - right.timeMs || left.id.localeCompare(right.id));
}

/** Resolve a direct, clamped timeline time into a complete object pose. */
export function illustrationObjectAtTime(document: IllustrationDocument, object: IllustrationObject, timeMs: number): IllustrationObject {
  const frames = illustrationKeyframesForObject(document, object.id);
  if (!frames.length) return object;
  const time = Math.max(0, Math.min(document.animation.durationMs, Number.isFinite(timeMs) ? timeMs : 0));
  const afterIndex = frames.findIndex((frame) => frame.timeMs >= time);
  if (afterIndex === 0) return { ...object, transform: structuredClone(frames[0].transform), opacity: frames[0].opacity, visible: frames[0].visible };
  if (afterIndex < 0) { const last = frames.at(-1)!; return { ...object, transform: structuredClone(last.transform), opacity: last.opacity, visible: last.visible }; }
  const before = frames[afterIndex - 1]; const after = frames[afterIndex];
  const span = Math.max(1, after.timeMs - before.timeMs); const progress = ease((time - before.timeMs) / span, before.easing);
  return {
    ...object,
    transform: interpolateTransform(before.transform, after.transform, progress),
    opacity: lerp(before.opacity, after.opacity, progress),
    visible: progress >= 1 ? after.visible : before.visible,
  };
}

/** Return a render-only clone; the canonical object revisions remain untouched. */
export function illustrationAtTime(document: IllustrationDocument, timeMs: number): IllustrationDocument {
  const resolved = structuredClone(document);
  for (const [id, object] of Object.entries(document.objects)) resolved.objects[id] = illustrationObjectAtTime(document, object, timeMs);
  return resolved;
}

export function illustrationPlaybackTime(animation: IllustrationAnimation, elapsedMs: number): number {
  const duration = Math.max(1, animation.durationMs); const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  if (animation.playback === 'once') return Math.min(duration, elapsed);
  if (animation.playback === 'loop') return elapsed % duration;
  const phase = elapsed % (duration * 2);
  return phase <= duration ? phase : duration * 2 - phase;
}

export interface IllustrationAnimationSample { timeMs: number; delayMs: number }

export function illustrationAnimationSamples(animation: IllustrationAnimation, maxFrames = 10_000): IllustrationAnimationSample[] {
  const frameDelay = 1_000 / animation.framesPerSecond;
  const forwardCount = Math.max(1, Math.ceil(animation.durationMs / frameDelay));
  const forward = Array.from({ length: forwardCount }, (_, index) => ({ timeMs: Math.min(animation.durationMs, index * frameDelay), delayMs: frameDelay }));
  const samples = animation.playback === 'ping-pong' && forward.length > 2 ? [...forward, ...forward.slice(1, -1).reverse()] : forward;
  if (samples.length > maxFrames) throw new Error(`Illustration animation would render ${samples.length} frames; the limit is ${maxFrames}.`);
  return samples;
}

export interface PixelAnimationEntityContext {
  actorId: Id;
  timestamp: string;
  createId?: (prefix: string) => Id;
}

export interface DuplicatedPixelFrame {
  frame: PixelFrame;
  cels: PixelCel[];
  index: number;
}

function rawCelForFrame(sprite: PixelSprite, layerId: Id, frameId: Id): PixelCel | undefined {
  return Object.values(sprite.cels).find((cel) => cel.layerId === layerId && cel.frameId === frameId);
}

export function resolvePixelCel(sprite: PixelSprite, celId: Id): PixelCel | undefined {
  let cel = sprite.cels[celId];
  const visited = new Set<Id>();
  while (cel?.linkedToCelId) {
    if (visited.has(cel.id)) return undefined;
    visited.add(cel.id);
    cel = sprite.cels[cel.linkedToCelId];
  }
  return cel;
}

export function pixelCelForFrame(sprite: PixelSprite, layerId: Id, frameId: Id): PixelCel | undefined {
  const cel = rawCelForFrame(sprite, layerId, frameId);
  return cel ? resolvePixelCel(sprite, cel.id) : undefined;
}

export function duplicatePixelFrame(sprite: PixelSprite, frameId: Id, context: PixelAnimationEntityContext): DuplicatedPixelFrame {
  const sourceFrame = sprite.frames[frameId];
  if (!sourceFrame) throw new Error(`Frame ${frameId} does not exist.`);
  const sourceIndex = sprite.frameIds.indexOf(frameId);
  if (sourceIndex < 0) throw new Error(`Frame ${frameId} is not ordered in the sprite.`);
  const makeId = context.createId ?? defaultCreateId;
  const newFrameId = makeId('frame');
  const frame: PixelFrame = {
    ...structuredClone(sourceFrame),
    id: newFrameId,
    revision: 0,
    name: `${sourceFrame.name} copy`,
    createdAt: context.timestamp,
    updatedAt: context.timestamp,
    createdBy: context.actorId,
  };
  const cels = sprite.layerIds
    .map((layerId) => sprite.layers[layerId])
    .filter((layer) => layer?.type === 'pixel')
    .map((layer) => {
      const source = pixelCelForFrame(sprite, layer.id, frameId);
      return {
        id: makeId('cel'),
        revision: 0,
        name: `${layer.name} · ${frame.name}`,
        createdAt: context.timestamp,
        updatedAt: context.timestamp,
        createdBy: context.actorId,
        layerId: layer.id,
        frameId: newFrameId,
        chunks: structuredClone(source?.chunks ?? {}),
      } satisfies PixelCel;
    });
  return { frame, cels, index: sourceIndex + 1 };
}

export function reorderPixelFrame(sprite: PixelSprite, frameId: Id, direction: -1 | 1): PixelSprite {
  const index = sprite.frameIds.indexOf(frameId);
  const target = index + direction;
  if (index < 0) throw new Error(`Frame ${frameId} does not exist.`);
  if (target < 0 || target >= sprite.frameIds.length) throw new Error('The frame is already at that edge of the timeline.');
  const next = structuredClone(sprite);
  [next.frameIds[index], next.frameIds[target]] = [next.frameIds[target], next.frameIds[index]];
  next.tags = next.tags.map((tag) => next.frameIds.indexOf(tag.fromFrameId) <= next.frameIds.indexOf(tag.toFrameId)
    ? tag
    : { ...tag, fromFrameId: tag.toFrameId, toFrameId: tag.fromFrameId });
  return next;
}

export function setPixelFrameCelsLinked(sprite: PixelSprite, frameId: Id, linked: boolean): PixelSprite {
  const frameIndex = sprite.frameIds.indexOf(frameId);
  if (frameIndex < 0) throw new Error(`Frame ${frameId} does not exist.`);
  if (linked && frameIndex === 0) throw new Error('The first frame has no previous cels to link.');
  const rawCels = Object.values(sprite.cels).filter((cel) => cel.frameId === frameId);
  const next = structuredClone(sprite);
  const previousFrameId = sprite.frameIds[frameIndex - 1];
  for (const raw of rawCels) {
    const cel = next.cels[raw.id];
    if (linked) {
      const source = pixelCelForFrame(sprite, raw.layerId, previousFrameId);
      if (!source) throw new Error(`Previous frame has no cel for layer ${raw.layerId}.`);
      cel.linkedToCelId = source.id;
      cel.chunks = {};
    } else {
      const resolved = resolvePixelCel(sprite, raw.id);
      if (!resolved) throw new Error(`Cel ${raw.id} has a cyclic or missing link.`);
      cel.chunks = structuredClone(resolved.chunks);
      delete cel.linkedToCelId;
    }
  }
  return next;
}

export function upsertPixelAnimationTag(sprite: PixelSprite, tag: AnimationTag): PixelSprite {
  const fromIndex = sprite.frameIds.indexOf(tag.fromFrameId);
  const toIndex = sprite.frameIds.indexOf(tag.toFrameId);
  if (!tag.id || !tag.name.trim()) throw new Error('Animation tags require an id and name.');
  if (fromIndex < 0 || toIndex < fromIndex) throw new Error('The animation tag range is invalid.');
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(tag.color)) throw new Error('Animation tag colors must be hex RGB or RGBA values.');
  const next = structuredClone(sprite);
  const normalized = { ...structuredClone(tag), name: tag.name.trim() };
  const index = next.tags.findIndex((entry) => entry.id === tag.id);
  if (index >= 0) next.tags[index] = normalized;
  else next.tags.push(normalized);
  return next;
}

export function deletePixelAnimationTag(sprite: PixelSprite, tagId: Id): PixelSprite {
  if (!sprite.tags.some((tag) => tag.id === tagId)) throw new Error(`Animation tag ${tagId} does not exist.`);
  const next = structuredClone(sprite);
  next.tags = next.tags.filter((tag) => tag.id !== tagId);
  return next;
}

export function setPixelFramePaletteOverride(sprite: PixelSprite, frameId: Id, palette?: PaletteEntry[]): PixelSprite {
  if (!sprite.frames[frameId]) throw new Error(`Frame ${frameId} does not exist.`);
  if (palette && (palette.length < 1 || palette.length > 256)) throw new Error('A frame palette override must contain 1–256 entries.');
  const next = structuredClone(sprite);
  if (palette) next.paletteOverrides[frameId] = structuredClone(palette);
  else delete next.paletteOverrides[frameId];
  return next;
}

export function pixelAnimationFrames(sprite: PixelSprite, tagId?: Id): Id[] {
  const tag = tagId ? sprite.tags.find((entry) => entry.id === tagId) : undefined;
  if (!tag) return [...sprite.frameIds];
  const from = sprite.frameIds.indexOf(tag.fromFrameId);
  const to = sprite.frameIds.indexOf(tag.toFrameId);
  return from >= 0 && to >= from ? sprite.frameIds.slice(from, to + 1) : [];
}

export function pixelAnimationSequence(sprite: PixelSprite, tagId?: Id): Id[] {
  const frames = pixelAnimationFrames(sprite, tagId); if (!tagId) return frames;
  const tag = sprite.tags.find((entry) => entry.id === tagId); if (!tag) throw new Error(`Animation tag ${tagId} does not exist.`);
  if (!frames.length) throw new Error(`Animation tag ${tagId} has an invalid frame range.`);
  if (tag.direction === 'reverse') return [...frames].reverse();
  if (tag.direction === 'ping-pong' && frames.length > 2) return [...frames, ...frames.slice(1, -1).reverse()];
  return frames;
}
