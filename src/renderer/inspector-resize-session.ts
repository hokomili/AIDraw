import { inspectorWidthAfterPointerMove } from '../common/workspace-layout';

export interface InspectorPointerCaptureTarget {
  setPointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
  releasePointerCapture(pointerId: number): void;
}

interface ResizeGesture {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  target: InspectorPointerCaptureTarget;
}

export interface FinishedInspectorPointerResize {
  startWidth: number;
  width: number;
}

/** One pointer-resize admission whose cleared state rejects every stale terminal event. */
export class InspectorPointerResizeSession {
  private gesture?: ResizeGesture;

  begin(
    pointerId: number,
    startClientX: number,
    startWidth: number,
    target: InspectorPointerCaptureTarget,
  ): boolean {
    if (this.gesture) return false;
    try { target.setPointerCapture(pointerId); }
    catch { return false; }
    this.gesture = { pointerId, startClientX, startWidth, target };
    return true;
  }

  width(pointerId: number, clientX: number, maximumEffectiveWidth: number): number | undefined {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== pointerId) return undefined;
    return inspectorWidthAfterPointerMove(gesture.startWidth, gesture.startClientX, clientX, maximumEffectiveWidth);
  }

  finish(pointerId: number, clientX: number, maximumEffectiveWidth: number): FinishedInspectorPointerResize | undefined {
    const gesture = this.gesture;
    const width = this.width(pointerId, clientX, maximumEffectiveWidth);
    if (!gesture || width === undefined) return undefined;
    this.clear(gesture);
    return { startWidth: gesture.startWidth, width };
  }

  cancel(pointerId?: number): boolean {
    const gesture = this.gesture;
    if (!gesture || (pointerId !== undefined && gesture.pointerId !== pointerId)) return false;
    this.clear(gesture);
    return true;
  }

  private clear(gesture: ResizeGesture): void {
    this.gesture = undefined;
    try {
      if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
    } catch {
      // Capture may already have been released by the host; cleared session state remains authoritative.
    }
  }
}

export function cancelInspectorResizeIfCollapsed(
  collapsed: boolean,
  session: InspectorPointerResizeSession,
): boolean {
  return collapsed && session.cancel();
}
