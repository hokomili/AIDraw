import { useLayoutEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Repeat2 } from 'lucide-react';
import {
  DEFAULT_WORKSPACE_LAYOUT_PREFERENCES,
  MIN_INSPECTOR_EXPANDED_WIDTH,
  inspectorWidthAfterKeyboardMove,
} from '../../common/workspace-layout';
import { InspectorPointerResizeSession, cancelInspectorResizeIfCollapsed } from '../inspector-resize-session';

export interface InspectorLayoutControlsProps {
  collapsed: boolean;
  savedWidth: number;
  effectiveWidth: number;
  maximumEffectiveWidth: number;
  onResizePreview(width: number): void;
  onResizeCommit(width: number): void;
  onResizeCancel(): void;
  onReset(): void;
}

export function InspectorLayoutControls({
  collapsed,
  savedWidth,
  effectiveWidth,
  maximumEffectiveWidth,
  onResizePreview,
  onResizeCommit,
  onResizeCancel,
  onReset,
}: InspectorLayoutControlsProps) {
  const [resizeSession] = useState(() => new InspectorPointerResizeSession());

  useLayoutEffect(() => {
    if (cancelInspectorResizeIfCollapsed(collapsed, resizeSession)) onResizeCancel();
  }, [collapsed, onResizeCancel, resizeSession]);

  useLayoutEffect(() => () => { resizeSession.cancel(); }, [resizeSession]);

  const finishPointerResize = (event: PointerEvent<HTMLDivElement>) => {
    const finished = resizeSession.finish(event.pointerId, event.clientX, maximumEffectiveWidth);
    if (!finished) return;
    if (finished.width !== finished.startWidth) onResizeCommit(finished.width);
    onResizeCancel();
  };

  const cancelPointerResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeSession.cancel(event.pointerId)) onResizeCancel();
  };

  const handleKeyboardResize = (event: KeyboardEvent<HTMLDivElement>) => {
    const width = inspectorWidthAfterKeyboardMove(effectiveWidth, event.key, event.shiftKey, maximumEffectiveWidth);
    if (width === undefined) return;
    event.preventDefault();
    if (width !== effectiveWidth) onResizeCommit(width);
  };

  const clamped = effectiveWidth !== savedWidth;
  const atDefault = savedWidth === DEFAULT_WORKSPACE_LAYOUT_PREFERENCES.inspectorExpandedWidth;

  return (
    <div className="inspector-layout-controls">
      <div
        className="inspector-resize-handle"
        role="separator"
        aria-label="Resize inspector sidebar"
        aria-describedby="inspector-resize-help"
        aria-orientation="vertical"
        aria-valuemin={MIN_INSPECTOR_EXPANDED_WIDTH}
        aria-valuemax={maximumEffectiveWidth}
        aria-valuenow={effectiveWidth}
        aria-valuetext={clamped ? `${effectiveWidth} pixels shown; ${savedWidth} pixels saved` : `${effectiveWidth} pixels`}
        tabIndex={0}
        onKeyDown={handleKeyboardResize}
        onPointerDown={(event) => {
          if (event.button === 0 && resizeSession.begin(event.pointerId, event.clientX, effectiveWidth, event.currentTarget)) {
            onResizePreview(effectiveWidth);
          }
        }}
        onPointerMove={(event) => {
          const width = resizeSession.width(event.pointerId, event.clientX, maximumEffectiveWidth);
          if (width !== undefined) onResizePreview(width);
        }}
        onPointerUp={finishPointerResize}
        onPointerCancel={cancelPointerResize}
        onLostPointerCapture={(event) => {
          if (resizeSession.cancel(event.pointerId)) onResizeCancel();
        }}
      >
        <span aria-hidden="true" />
      </div>
      <span id="inspector-resize-help" className="visually-hidden">
        Use Left and Right Arrow keys to resize. Home uses {MIN_INSPECTOR_EXPANDED_WIDTH} pixels. End uses the current {maximumEffectiveWidth} pixel viewport maximum.
        {clamped ? ` ${savedWidth} pixels remain saved until a visible resize is committed.` : ''}
      </span>
      <span className="inspector-layout-summary">
        <strong>Inspector</strong>
        <small>{clamped ? `${effectiveWidth}px shown · ${savedWidth}px saved` : `${effectiveWidth}px wide`}</small>
      </span>
      <button
        type="button"
        className="inspector-layout-reset"
        aria-label="Reset inspector layout to default"
        title="Reset inspector layout to default"
        disabled={atDefault}
        onClick={onReset}
      >
        <Repeat2 size={16} />
        <span>Reset</span>
      </button>
    </div>
  );
}
