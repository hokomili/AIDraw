import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { EDITOR_DENSITY } from '../../src/common/editor-layout';
import {
  DEFAULT_WORKSPACE_LAYOUT_PREFERENCES,
  MIN_INSPECTOR_EXPANDED_WIDTH,
} from '../../src/common/workspace-layout';
import { InspectorLayoutControls } from '../../src/renderer/components/InspectorLayoutControls';
import {
  InspectorPointerResizeSession,
  cancelInspectorResizeIfCollapsed,
  type InspectorPointerCaptureTarget,
} from '../../src/renderer/inspector-resize-session';

describe('customizable inspector workspace', () => {
  it('renders one named composite resize route and a density-compliant reset action', () => {
    const markup = renderToStaticMarkup(createElement(InspectorLayoutControls, {
      collapsed: false,
      savedWidth: 472,
      effectiveWidth: 286,
      maximumEffectiveWidth: 286,
      onResizePreview: () => undefined,
      onResizeCommit: () => undefined,
      onResizeCancel: () => undefined,
      onReset: () => undefined,
    }));
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Resize inspector sidebar"');
    expect(markup).toContain(`aria-valuemin="${MIN_INSPECTOR_EXPANDED_WIDTH}"`);
    expect(markup).toContain('aria-valuemax="286"');
    expect(markup).toContain('aria-valuenow="286"');
    expect(markup).toContain('aria-valuetext="286 pixels shown; 472 pixels saved"');
    expect(markup).toContain('End uses the current 286 pixel viewport maximum. 472 pixels remain saved until a visible resize is committed.');
    expect(markup).toContain('286px shown · 472px saved');
    expect(markup).toContain('aria-label="Reset inspector layout to default"');
    expect(markup).toContain('<span>Reset</span>');
  });

  it('cancels a captured resize on collapse and rejects its stale terminal event before a later gesture', () => {
    const captured = new Set<number>();
    const released: number[] = [];
    const target: InspectorPointerCaptureTarget = {
      setPointerCapture: (pointerId) => { captured.add(pointerId); },
      hasPointerCapture: (pointerId) => captured.has(pointerId),
      releasePointerCapture: (pointerId) => { captured.delete(pointerId); released.push(pointerId); },
    };
    const session = new InspectorPointerResizeSession();

    expect(session.begin(7, 800, 286, target)).toBe(true);
    expect(session.width(7, 808, 286)).toBe(278);
    expect(cancelInspectorResizeIfCollapsed(false, session)).toBe(false);
    expect(captured.has(7)).toBe(true);
    expect(cancelInspectorResizeIfCollapsed(true, session)).toBe(true);
    expect(captured.has(7)).toBe(false);
    expect(released).toEqual([7]);

    expect(session.begin(8, 500, 318, target)).toBe(true);
    expect(session.finish(7, 808, 286)).toBeUndefined();
    expect(captured.has(8)).toBe(true);
    expect(session.finish(8, 492, 520)).toEqual({ startWidth: 318, width: 326 });
    expect(released).toEqual([7, 8]);
  });

  it('binds bootstrap-owned layout, global reopen, focus recovery, dynamic presentation, and exact density tokens', async () => {
    const [app, store, styles, shortcuts, preferences] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/store.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/shortcuts.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/common/workspace-layout.ts', import.meta.url), 'utf8'),
    ]);
    expect(store).toContain('workspaceLayoutPreferences: structuredClone(snapshot.workspaceLayoutPreferences)');
    expect(store).not.toContain('setWorkspaceLayoutPreferences(DEFAULT_WORKSPACE_LAYOUT_PREFERENCES)');
    expect(app).toContain('if (loading || !document) return <LoadingScreen />;');
    expect(app).toContain('inspectorToggleShortcutRequested(event)');
    expect(app).toContain('id="inspector-toggle-button"');
    expect(app).toContain('aria-controls="inspector-sidebar"');
    expect(app).toContain('aria-label="Inspector sidebar" hidden={collapsed}');
    expect(app).toContain('aria-keyshortcuts="Control+Shift+I Meta+Shift+I"');
    expect(app).toContain('focusActiveInspectorTab()');
    expect(app).toContain('focusInspectorToggle()');
    expect(app).toContain('effectiveInspectorWidth(requestedInspectorWidth, viewportWidth)');
    expect(app).toContain('effectiveInspectorWidth(MAX_INSPECTOR_EXPANDED_WIDTH, viewportWidth)');
    expect(app).toContain('setWorkspaceLayoutPreferences({ ...DEFAULT_WORKSPACE_LAYOUT_PREFERENCES })');
    expect(app).toContain('inspectorExpandedWidth,');
    expect(app).toContain('savedWidth={workspaceLayoutPreferences.inspectorExpandedWidth}');
    expect(app).toContain('maximumEffectiveWidth={maximumShownInspectorWidth}');
    expect(app).toContain('effectiveWidth={shownInspectorWidth}');
    const controls = await readFile(new URL('../../src/renderer/components/InspectorLayoutControls.tsx', import.meta.url), 'utf8');
    expect(controls).toContain('resizeSession.begin(event.pointerId, event.clientX, effectiveWidth, event.currentTarget)');
    expect(controls).toContain('inspectorWidthAfterKeyboardMove(effectiveWidth, event.key, event.shiftKey, maximumEffectiveWidth)');
    expect(controls).toContain('if (width !== effectiveWidth) onResizeCommit(width)');
    expect(preferences).not.toContain('@aidraw/core');
    expect(shortcuts).toContain("label: 'Open or collapse the inspector sidebar'");
    expect(styles).toContain('grid-template-columns: var(--shell-tool-rail-width) minmax(0, 1fr) var(--shell-sidebar-effective-width);');
    expect(styles).toContain('.inspector-layout-reset { min-width: var(--ui-hit-secondary); height: var(--ui-hit-secondary);');
    expect(styles).toContain('.inspector-layout-reset svg { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary); }');
    expect(styles).toContain('.inspector-resize-handle { position: absolute; top: 0; bottom: 0; left: -16px; width: var(--ui-hit-secondary);');
    expect(EDITOR_DENSITY.secondaryHitTarget).toBe(32);
    expect(EDITOR_DENSITY.secondaryIcon).toBe(18);
    expect(DEFAULT_WORKSPACE_LAYOUT_PREFERENCES.inspectorExpandedWidth).toBe(318);
  });
});
