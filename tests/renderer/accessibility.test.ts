import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('editor accessibility baseline', () => {
  it('retains keyboard, motion, contrast, and live-status affordances', async () => {
    const [app, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('@media (prefers-contrast: more)');
    expect(styles).toContain('@media (forced-colors: active)');
    expect(styles).toMatch(/:focus-visible/);
    expect(app).toContain('role="tablist"');
    expect(app).toContain('aria-haspopup="menu"');
    expect(app).toContain('aria-haspopup="dialog"');
    expect(app).toContain('role="tabpanel"');
    expect(app).toContain('aria-selected={visiblePanel ===');
    expect(app).toContain('aria-label="Canvas zoom"');
    expect(app).toContain('aria-label="Stop all agents working on this document"');
    expect(app).toContain('aria-label="Open agent activity"');
    expect(app).toContain('aria-live="polite"');
    expect(app).toContain('aria-modal="true"');
    expect(app).toContain('aria-describedby={description ? descriptionId : undefined}');
    expect(app).toContain('previouslyFocused?.isConnected');
    expect(app).toContain('event.key !== "Tab"');
    expect(app).not.toMatch(/\bwindow\.(?:prompt|confirm|alert)\s*\(/);
  });

  it('keeps both drawing surfaces focusable and named', async () => {
    const [illustration, pixel] = await Promise.all([
      readFile(new URL('../../src/renderer/canvas/IllustrationCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
    ]);
    for (const source of [illustration, pixel]) {
      expect(source).toContain('role="application"');
      expect(source).toContain('tabIndex={0}');
      expect(source).toMatch(/aria-label={`(?:Illustration|Pixel-art) canvas/);
    }
  });

  it('keeps MCP rotation and revocation explicit, named, and free of returned credential values', async () => {
    const [app, main, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(app).toContain('aria-label="MCP credential security"');
    expect(app).toContain('mcpAccessRevoked ? "Rotate and re-enable" : "Rotate credential"');
    expect(app).toContain('>Revoke access</button>');
    expect(app).toContain('setCredentials(undefined)');
    expect(app).toContain('setSetupResult(undefined)');
    expect(app).toContain('setCredentialResult(undefined)');
    expect(app).toContain('result.warning ? "warning" : "success"');
    expect(app).toContain('Rotating now re-enables the local endpoint and agent access with a new credential.');
    expect(app).toContain('Persistent folder approvals and already admitted or pending approval work remain');
    expect(app).toContain('neither action edits client configuration files');
    expect(styles).toContain('.credential-lifecycle strong { font-size: var(--ui-type-label); }');
    expect(styles).toContain('.credential-lifecycle small { margin-top: 3px; font-size: var(--ui-type-caption);');
    expect(styles).toContain('.credential-lifecycle-actions button { min-height: var(--ui-hit-secondary);');
    expect(styles).toContain('.credential-lifecycle p { margin: 7px 0 0; font-size: var(--ui-type-caption);');
    const changeStart = app.indexOf('const changeMcpCredential');
    const changeEnd = app.indexOf('\n  if (!document)', changeStart);
    const change = app.slice(changeStart, changeEnd);
    const failedChange = change.slice(change.indexOf('} catch (error) {'), change.indexOf('} finally {'));
    expect(failedChange).toContain('setCredentials(undefined)');
    expect(failedChange).toContain('setSetupResult(undefined)');
    expect(failedChange).toContain('setCredentialResult(undefined)');
    expect(failedChange).toContain('getEngineStatus().then(setEngine).catch(() => undefined)');
    const lifecycleStart = main.indexOf('async function confirmMcpCredentialChange');
    const lifecycleEnd = main.indexOf('\nfunction registerIpc', lifecycleStart);
    const lifecycle = main.slice(lifecycleStart, lifecycleEnd);
    expect(lifecycle).toContain("await engineRuntime.rotateMcpCredential()");
    expect(lifecycle).toContain("await engineRuntime.revokeMcpAccess()");
    expect(lifecycle).toContain('Create a new credential and re-enable the local MCP endpoint?');
    expect(lifecycle).toContain('Persistent folder approvals and already admitted or pending approval work remain');
    expect(lifecycle).toContain('approval jobs are not rolled back or silently cancelled');
    expect(lifecycle).toContain('transition.cleanupWarning');
    expect(lifecycle).toContain('Existing client configuration files are not edited');
    expect(lifecycle).not.toMatch(/\btoken\s*:/i);
    expect(lifecycle).not.toContain('mcpHost.credentials()');
    expect(lifecycle).not.toContain('clipboard');
  });
});
