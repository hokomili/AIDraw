import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { PixelAnimationTagSpan } from '@aidraw/core';
import {
  AnimationFrameTagMembership,
  AnimationTagStrip,
} from '../../src/renderer/components/AnimationTagTimeline';
import {
  animationAdvisoryDirection,
  animationTagFocusIndex,
  animationTagMembershipsForFrames,
  animationTagMembershipSummary,
  animationTagScopeMatches,
  resolveScopedAnimationTagId,
} from '../../src/renderer/animation-tag-timeline';

function span(id: string, name: string, order: number, fromIndex: number, toIndex: number, direction: PixelAnimationTagSpan['tag']['direction'] = 'forward'): PixelAnimationTagSpan {
  return {
    tag: { id, name, fromFrameId: `frame-${fromIndex + 1}`, toFrameId: `frame-${toIndex + 1}`, direction, color: order % 2 ? '#31a6a0' : '#8268dd' },
    order,
    fromIndex,
    toIndex,
    frameCount: toIndex - fromIndex + 1,
  };
}

describe('overlapping animation-tag timeline', () => {
  it('exposes independent duplicate-named ranges, multi-membership, and one roving tab stop', () => {
    const spans = [
      span('outer', 'Loop', 0, 0, 3, 'forward'),
      span('nested', 'Loop', 1, 1, 2, 'reverse'),
      span('identical', 'Echo', 2, 1, 2, 'ping-pong'),
    ];
    const markup = renderToStaticMarkup(createElement(AnimationTagStrip, {
      spans,
      activeFrameIndex: 1,
      selectedTagId: 'nested',
      onSelect: vi.fn(),
      onEdit: vi.fn(),
    }));
    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain('aria-label="Independent animation tags"');
    expect(markup).toContain('class="timeline-tags-help"');
    expect(markup).toContain('Each tag is an independent inclusive frame range.');
    expect(markup).toContain('Loop, tag 1 of 3, F1–F4, Forward, includes the active frame');
    expect(markup).toContain('Loop, tag 2 of 3, F2–F3, Reverse, includes the active frame');
    expect(markup).toContain('Echo, tag 3 of 3, F2–F3, Ping-pong, includes the active frame');
    expect((markup.match(/class="contains-active-frame"/gu) ?? [])).toHaveLength(2);
    expect(markup).toContain('class="is-active contains-active-frame"');
    expect((markup.match(/tabindex="0"/gu) ?? [])).toHaveLength(1);
    expect((markup.match(/tabindex="-1"/gu) ?? [])).toHaveLength(2);
    expect((markup.match(/aria-keyshortcuts="F2"/gu) ?? [])).toHaveLength(3);
  });

  it('wraps bounded tag focus and keeps activation separate from navigation', () => {
    expect(animationTagFocusIndex('ArrowRight', 2, 3)).toBe(0);
    expect(animationTagFocusIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(animationTagFocusIndex('Home', 2, 3)).toBe(0);
    expect(animationTagFocusIndex('End', 0, 3)).toBe(2);
    expect(animationTagFocusIndex('Enter', 1, 3)).toBeUndefined();
    expect(animationTagFocusIndex('ArrowRight', -1, 0)).toBeUndefined();
  });

  it('bounds visible frame badges while retaining exact membership count and guidance', () => {
    const spans = Array.from({ length: 5 }, (_, index) => span(`tag-${index}`, index < 2 ? 'Duplicate' : `Tag ${index + 1}`, index, 0, 2));
    const membership = animationTagMembershipsForFrames(spans, 3)[1];
    const summary = animationTagMembershipSummary(membership);
    const markup = renderToStaticMarkup(createElement(AnimationFrameTagMembership, { membership }));
    expect(summary).toBe('5 animation tag memberships: Duplicate (tag 1, F1–F3), Duplicate (tag 2, F1–F3), Tag 3 (tag 3, F1–F3), Tag 4 (tag 4, F1–F3), and 1 more.');
    expect((markup.match(/frame-tag-marker/gu) ?? [])).toHaveLength(4);
    expect(markup).toContain('frame-tag-more">+1');
  });

  it('retains at most four authored-order identities per frame while counting heavy overlap exactly', () => {
    const tagCount = 2_048;
    const frameCount = 256;
    const spans = Array.from({ length: tagCount }, (_, index) => span(`tag-${index}`, `Tag ${index + 1}`, index, 0, frameCount - 1));
    const memberships = animationTagMembershipsForFrames(spans, frameCount);
    expect(memberships).toHaveLength(frameCount);
    expect(memberships.every((membership) => membership.count === tagCount)).toBe(true);
    expect(memberships.every((membership) => membership.visibleSpans.map((entry) => entry.tag.id).join(',') === 'tag-0,tag-1,tag-2,tag-3')).toBe(true);
    expect(memberships.reduce((total, membership) => total + membership.visibleSpans.length, 0)).toBe(frameCount * 4);
    expect(animationTagMembershipSummary(memberships[255])).toContain('and 2044 more');
  });

  it('scopes preview and edit state to one exact sprite and clears stale reverse advisory truth', () => {
    const selection = { documentId: 'document', spriteId: 'sprite-a', tagId: 'shared-tag-id' };
    expect(resolveScopedAnimationTagId(selection, 'document', 'sprite-a', ['shared-tag-id'])).toBe('shared-tag-id');
    expect(resolveScopedAnimationTagId(selection, 'document', 'sprite-b', ['shared-tag-id'])).toBeUndefined();
    expect(animationAdvisoryDirection('reverse', false)).toBe('reverse');
    expect(animationAdvisoryDirection(undefined, false)).toBe('forward');
    expect(animationAdvisoryDirection(undefined, true)).toBe('ping-pong');
    expect(animationTagScopeMatches({ documentId: 'document', spriteId: 'sprite-a' }, 'document', 'sprite-a')).toBe(true);
    expect(animationTagScopeMatches({ documentId: 'document', spriteId: 'sprite-a' }, 'document', 'sprite-b')).toBe(false);
  });

  it('wires exact tag selection, membership summaries, compact scrolling, and stable ID refs into production', async () => {
    const [canvas, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(canvas).toContain('<AnimationTagStrip spans={animationTagSpans} activeFrameIndex={activeFrameIndex} selectedTagId={selectedTagId} onSelect={selectAnimationTag} onEdit={openTagDialog} />');
    expect(canvas).toContain('const activeTag = sprite?.tags.find((tag) => tag.id === selectedTagId);');
    expect(canvas).not.toContain("?? sprite?.tags.find((tag) =>");
    expect(canvas).toContain('animationTagMembershipsForFrames(animationTagSpans, sprite?.frameIds.length ?? 0)');
    expect(canvas).toContain('animationTagMembershipSummary(membership)');
    expect(canvas).not.toContain('animationTagSpans.filter((span) => index >= span.fromIndex && index <= span.toIndex)');
    expect(canvas).toContain('resolveScopedAnimationTagId(selectedTagSelection, document.id, sprite?.id, animationTagSpans.map((span) => span.tag.id))');
    expect(canvas).toContain("direction: animationAdvisoryDirection(activeTag?.direction, pingPong)");
    expect(canvas).not.toContain("playDirection < 0 ? 'reverse' : 'forward'");
    expect(canvas).toContain('const tagDraft = animationTagScopeMatches(tagDraftState, document.id, sprite?.id) && tagDraftTargetExists ? tagDraftState?.draft : undefined;');
    expect(canvas).toContain('if (!animationTagScopeMatches(tagDraftState, document.id, sprite.id)) return;');
    expect(canvas).toContain('pixelAnimationFrames(sprite, selectedTagId)');
    expect(canvas).toContain('`Edit animation tag ${tagDraftOrder + 1} of ${sprite.tags.length}`');
    expect(canvas).toContain('overlapping ranges and duplicate names remain separate');
    expect(styles).toMatch(/\.timeline-tags \{[^}]*overflow-x: auto/);
    expect(styles).toContain('.timeline-label button, .timeline-tags button { min-height: var(--ui-hit-secondary);');
    expect(styles).toMatch(/\.timeline-tags button \{[^}]*white-space: nowrap/);
    expect(styles).toMatch(/\.timeline-tags-help \{[^}]*clip-path: inset\(50%\)/);
  });
});
