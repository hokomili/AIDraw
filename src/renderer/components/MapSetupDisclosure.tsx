import { useRef, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { focusDisclosureTriggerBeforeCollapse } from '../disclosure-focus';

export function MapSetupDisclosure({
  children,
  expanded,
  onExpandedChange,
  summary,
}: {
  children: ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  summary: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = 'tilemap-map-setup-controls';
  const summaryId = 'tilemap-map-setup-summary';

  const toggle = () => {
    if (expanded) {
      focusDisclosureTriggerBeforeCollapse(
        expanded,
        Boolean(contentRef.current?.contains(globalThis.document.activeElement)),
        () => triggerRef.current?.focus(),
      );
    }
    onExpandedChange(!expanded);
  };

  return (
    <section className="map-setup-disclosure">
      <button
        ref={triggerRef}
        type="button"
        className="map-setup-disclosure-trigger"
        aria-controls={contentId}
        aria-describedby={summaryId}
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide map setup' : 'Show map setup'}
        onClick={toggle}
      >
        <span className="map-setup-disclosure-copy">
          <strong>Map setup</strong>
          <small id={summaryId}>{summary}</small>
        </span>
        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      </button>
      <div ref={contentRef} id={contentId} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
