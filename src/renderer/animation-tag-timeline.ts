import type { PixelAnimationTagSpan } from '@aidraw/core';

export const VISIBLE_FRAME_MEMBERSHIP_LIMIT = 4;

export interface AnimationTagFrameMembership {
  count: number;
  visibleSpans: PixelAnimationTagSpan[];
}

export interface ScopedAnimationTagSelection {
  documentId: string;
  spriteId: string;
  tagId: string;
}

export interface AnimationTagSpriteScope {
  documentId: string;
  spriteId: string;
}

export function animationTagScopeMatches(
  scope: AnimationTagSpriteScope | undefined,
  currentDocumentId: string | undefined,
  currentSpriteId: string | undefined,
): boolean {
  return Boolean(scope && currentDocumentId && currentSpriteId && scope.documentId === currentDocumentId && scope.spriteId === currentSpriteId);
}

export function resolveScopedAnimationTagId(
  selection: ScopedAnimationTagSelection | undefined,
  currentDocumentId: string | undefined,
  currentSpriteId: string | undefined,
  currentTagIds: readonly string[],
): string | undefined {
  if (!selection || !animationTagScopeMatches(selection, currentDocumentId, currentSpriteId)) return undefined;
  return currentTagIds.includes(selection.tagId) ? selection.tagId : undefined;
}

export function animationAdvisoryDirection(
  selectedDirection: PixelAnimationTagSpan['tag']['direction'] | undefined,
  pingPong: boolean,
): PixelAnimationTagSpan['tag']['direction'] {
  return selectedDirection ?? (pingPong ? 'ping-pong' : 'forward');
}

export function animationTagDirectionLabel(direction: PixelAnimationTagSpan['tag']['direction']): string {
  if (direction === 'ping-pong') return 'Ping-pong';
  return direction === 'reverse' ? 'Reverse' : 'Forward';
}

export function animationTagRangeLabel(span: PixelAnimationTagSpan): string {
  return `F${span.fromIndex + 1}–F${span.toIndex + 1}`;
}

export function animationTagMembershipsForFrames(spans: readonly PixelAnimationTagSpan[], frameCount: number): AnimationTagFrameMembership[] {
  if (!Number.isSafeInteger(frameCount) || frameCount < 0) throw new Error('Animation frame count must be a nonnegative safe integer.');
  const memberships = Array.from({ length: frameCount }, () => ({ count: 0, visibleSpans: [] as PixelAnimationTagSpan[] }));
  if (frameCount === 0) {
    if (spans.length) throw new Error('Animation tag ranges require at least one frame.');
    return memberships;
  }

  const countChanges = new Int32Array(frameCount + 1);
  for (const span of spans) {
    if (!Number.isSafeInteger(span.fromIndex) || !Number.isSafeInteger(span.toIndex) || span.fromIndex < 0 || span.toIndex < span.fromIndex || span.toIndex >= frameCount) {
      throw new Error('Animation tag range is outside the frame list.');
    }
    countChanges[span.fromIndex] += 1;
    countChanges[span.toIndex + 1] -= 1;
  }
  let count = 0;
  for (let index = 0; index < frameCount; index += 1) {
    count += countChanges[index];
    memberships[index].count = count;
  }

  // Once a frame has retained its first four authored-order spans, skip it for
  // every later span. This bounds both retained references and range visits to
  // four per frame without truncating the exact difference-array count above.
  const nextUnfilled = new Int32Array(frameCount + 1);
  for (let index = 0; index <= frameCount; index += 1) nextUnfilled[index] = index;
  const findNextUnfilled = (candidate: number): number => {
    let root = candidate;
    while (nextUnfilled[root] !== root) root = nextUnfilled[root];
    let cursor = candidate;
    while (nextUnfilled[cursor] !== cursor) {
      const parent = nextUnfilled[cursor];
      nextUnfilled[cursor] = root;
      cursor = parent;
    }
    return root;
  };
  for (const span of spans) {
    let index = findNextUnfilled(span.fromIndex);
    while (index <= span.toIndex) {
      const visibleSpans = memberships[index].visibleSpans;
      visibleSpans.push(span);
      if (visibleSpans.length === VISIBLE_FRAME_MEMBERSHIP_LIMIT) nextUnfilled[index] = findNextUnfilled(index + 1);
      index = findNextUnfilled(index + 1);
    }
  }
  return memberships;
}

export function animationTagMembershipSummary(membership: AnimationTagFrameMembership): string {
  if (!membership.count) return 'No animation tag membership.';
  const visible = membership.visibleSpans
    .map((span) => `${span.tag.name} (tag ${span.order + 1}, ${animationTagRangeLabel(span)})`);
  const remainder = membership.count - visible.length;
  const members = remainder > 0 ? `${visible.join(', ')}, and ${remainder} more` : visible.join(', ');
  return `${membership.count} animation tag ${membership.count === 1 ? 'membership' : 'memberships'}: ${members}.`;
}

export function animationTagFocusIndex(key: string, currentIndex: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  const current = currentIndex >= 0 && currentIndex < count ? currentIndex : 0;
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return undefined;
}
