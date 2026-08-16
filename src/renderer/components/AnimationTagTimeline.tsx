import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { PixelAnimationTagSpan } from '@aidraw/core';
import { animationTagDirectionLabel, animationTagFocusIndex, animationTagMembershipSummary, animationTagRangeLabel, type AnimationTagFrameMembership } from '../animation-tag-timeline';

export function AnimationFrameTagMembership({ membership }: { membership: AnimationTagFrameMembership }) {
  if (!membership.count) return null;
  return <span className="frame-tag-membership" aria-hidden="true" title={animationTagMembershipSummary(membership)}>
    {membership.visibleSpans.map((span) => <span key={span.tag.id} className="frame-tag-marker" style={{ '--tag-color': span.tag.color } as CSSProperties} />)}
    {membership.count > membership.visibleSpans.length && <span className="frame-tag-more">+{membership.count - membership.visibleSpans.length}</span>}
  </span>;
}

export function AnimationTagStrip({
  spans,
  activeFrameIndex,
  selectedTagId,
  onSelect,
  onEdit,
}: {
  spans: PixelAnimationTagSpan[];
  activeFrameIndex: number;
  selectedTagId?: string;
  onSelect: (tagId?: string) => void;
  onEdit: (tagId: string) => void;
}) {
  const helpId = useId();
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [rovingTagId, setRovingTagId] = useState(() => spans.some((span) => span.tag.id === selectedTagId) ? selectedTagId : spans[0]?.tag.id);

  const resolvedRovingTagId = spans.some((span) => span.tag.id === rovingTagId)
    ? rovingTagId
    : spans.some((span) => span.tag.id === selectedTagId) ? selectedTagId : spans[0]?.tag.id;

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tagId: string) => {
    if (event.key === 'F2') {
      event.preventDefault();
      onEdit(tagId);
      return;
    }
    const currentIndex = spans.findIndex((span) => span.tag.id === tagId);
    const nextIndex = animationTagFocusIndex(event.key, currentIndex, spans.length);
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextId = spans[nextIndex].tag.id;
    setRovingTagId(nextId);
    buttonRefs.current.get(nextId)?.focus();
  };

  return <div className="timeline-tags" role="toolbar" aria-label="Independent animation tags" aria-describedby={helpId}>
    <span id={helpId} className="timeline-tags-help">Each tag is an independent inclusive frame range. Arrow keys move between tags, Home and End move to the first or last tag, Enter or Space selects only that tag for preview, and F2 edits that exact tag.</span>
    {spans.map((span) => {
      const selected = selectedTagId === span.tag.id;
      const containsActiveFrame = activeFrameIndex >= span.fromIndex && activeFrameIndex <= span.toIndex;
      const direction = animationTagDirectionLabel(span.tag.direction);
      const range = animationTagRangeLabel(span);
      const accessibleName = `${span.tag.name}, tag ${span.order + 1} of ${spans.length}, ${range}, ${direction}${containsActiveFrame ? ', includes the active frame' : ''}`;
      return <button
        key={span.tag.id}
        ref={(node) => { if (node) buttonRefs.current.set(span.tag.id, node); else buttonRefs.current.delete(span.tag.id); }}
        type="button"
        aria-label={accessibleName}
        aria-pressed={selected}
        aria-keyshortcuts="F2"
        tabIndex={resolvedRovingTagId === span.tag.id ? 0 : -1}
        className={[selected ? 'is-active' : '', containsActiveFrame ? 'contains-active-frame' : ''].filter(Boolean).join(' ')}
        style={{ '--tag-color': span.tag.color } as CSSProperties}
        onFocus={() => setRovingTagId(span.tag.id)}
        onKeyDown={(event) => handleKeyDown(event, span.tag.id)}
        onClick={() => onSelect(selected ? undefined : span.tag.id)}
        onDoubleClick={() => onEdit(span.tag.id)}
        title={`Select ${accessibleName}. Double-click or press F2 to edit this exact tag.`}
      >
        <span className="timeline-tag-name">{span.tag.name}</span>
        <span className="timeline-tag-range">{range} · {direction}</span>
      </button>;
    })}
  </div>;
}
