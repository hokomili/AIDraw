import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EngineRuntime } from '@main/engine-runtime';
import { DEFAULT_ONION_SKIN_PREFERENCES } from '../../src/common/onion-skin';
import { DEFAULT_ORDERED_DITHER_PREFERENCES, type OrderedDitherPreferences } from '../../src/common/ordered-dither-preferences';
import { DEFAULT_SPRITE_SYMMETRY_PREFERENCES } from '../../src/common/sprite-symmetry';
import { DEFAULT_WORKSPACE_LAYOUT_PREFERENCES } from '../../src/common/workspace-layout';
import { assignShortcut, defaultShortcutPreferences } from '../../src/common/shortcut-preferences';

describe('EngineRuntime stop', () => {
  it('binds bootstrap hydration and preference saves through the named trusted-renderer IPC boundary', async () => {
    const source = await readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
    expect(source).toContain('handle(IPC.bootstrap, () => engineRuntime.editorBootstrap())');
    expect(source).toContain('handle(IPC.onionSkinPreferencesSet, (_event, value: unknown) => engineRuntime.setOnionSkinPreferences(value))');
    expect(source).toContain('handle(IPC.orderedDitherPreferencesSet, (_event, value: unknown) => engineRuntime.setOrderedDitherPreferences(value))');
    expect(source).toContain('handle(IPC.spriteSymmetryPreferencesSet, (_event, value: unknown) => engineRuntime.setSpriteSymmetryPreferences(value))');
    expect(source).toContain('handle(IPC.workspaceLayoutPreferencesSet, (_event, value: unknown) => engineRuntime.setWorkspaceLayoutPreferences(value))');
    expect(source).toContain('handle(IPC.shortcutPreferencesSet, (_event, value: unknown) => engineRuntime.setShortcutPreferences(value))');
  });

  it('hydrates onion preferences through bootstrap, merges one advisory, and bounds save failures', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-onion-preference-test', appVersion: 'test' });
    runtime.service.initialize();
    const durable = { ...DEFAULT_ONION_SKIN_PREFERENCES, enabled: false, previousFrames: 4 };
    vi.spyOn(runtime.onionSkinPreferences, 'bootstrap').mockResolvedValue({
      preferences: durable,
      warning: 'Onion preference recovery advisory.',
    });
    vi.spyOn(runtime.spriteSymmetryPreferences, 'bootstrap').mockResolvedValue({
      preferences: { mode: DEFAULT_SPRITE_SYMMETRY_PREFERENCES.mode, bindings: [] },
    });
    vi.spyOn(runtime.orderedDitherPreferences, 'bootstrap').mockResolvedValue({
      preferences: { current: { ...DEFAULT_ORDERED_DITHER_PREFERENCES.current }, presets: [], activePresetId: null },
    });
    vi.spyOn(runtime.workspaceLayoutPreferences, 'bootstrap').mockResolvedValue({ preferences: { ...DEFAULT_WORKSPACE_LAYOUT_PREFERENCES } });

    await expect(runtime.editorBootstrap()).resolves.toMatchObject({
      onionSkinPreferences: durable,
      recoveryWarnings: ['Onion preference recovery advisory.'],
    });

    const save = vi.spyOn(runtime.onionSkinPreferences, 'save')
      .mockRejectedValueOnce(new Error('Injected preference replacement failure.'))
      .mockResolvedValueOnce(durable);
    await expect(runtime.setOnionSkinPreferences({ ...durable, previousFrames: 5 })).resolves.toEqual({
      saved: false,
      message: 'AIDraw rejected invalid onion skin preferences; the saved preference was not changed.',
    });
    expect(save).not.toHaveBeenCalled();
    await expect(runtime.setOnionSkinPreferences(durable)).resolves.toEqual({
      saved: false,
      message: 'Onion skin changed in this editor, but AIDraw could not save it. The previous saved preference remains.',
    });
    await expect(runtime.setOnionSkinPreferences(durable)).resolves.toEqual({ saved: true, preferences: durable });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('hydrates and bounds complete sprite symmetry preference saves without exposing document mutation authority', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-symmetry-preference-test', appVersion: 'test' });
    runtime.service.initialize();
    const durable = { mode: 'both' as const, bindings: [{ documentId: 'doc', spriteId: 'sprite', width: 8, height: 6, horizontalAxis: 2.5, verticalAxis: 3 }] };
    vi.spyOn(runtime.onionSkinPreferences, 'bootstrap').mockResolvedValue({ preferences: { ...DEFAULT_ONION_SKIN_PREFERENCES } });
    vi.spyOn(runtime.orderedDitherPreferences, 'bootstrap').mockResolvedValue({ preferences: { current: { ...DEFAULT_ORDERED_DITHER_PREFERENCES.current }, presets: [], activePresetId: null } });
    vi.spyOn(runtime.spriteSymmetryPreferences, 'bootstrap').mockResolvedValue({ preferences: durable, warning: 'Symmetry preference recovery advisory.' });
    vi.spyOn(runtime.workspaceLayoutPreferences, 'bootstrap').mockResolvedValue({ preferences: { ...DEFAULT_WORKSPACE_LAYOUT_PREFERENCES } });
    await expect(runtime.editorBootstrap()).resolves.toMatchObject({ symmetryPreferences: durable, recoveryWarnings: ['Symmetry preference recovery advisory.'] });

    const save = vi.spyOn(runtime.spriteSymmetryPreferences, 'save').mockRejectedValueOnce(new Error('Injected replacement failure.')).mockResolvedValueOnce(durable);
    await expect(runtime.setSpriteSymmetryPreferences({ ...durable, bindings: [{ ...durable.bindings[0], horizontalAxis: 2.25 }] })).resolves.toEqual({
      saved: false, message: 'AIDraw rejected invalid sprite symmetry preferences; the saved preference was not changed.',
    });
    expect(save).not.toHaveBeenCalled();
    await expect(runtime.setSpriteSymmetryPreferences(durable)).resolves.toEqual({
      saved: false, message: 'Sprite symmetry changed in this editor, but AIDraw could not save it. The previous saved preference remains.',
    });
    await expect(runtime.setSpriteSymmetryPreferences(durable)).resolves.toEqual({ saved: true, preferences: durable });
  });

  it('hydrates and bounds complete ordered dither preference saves without exposing palette or document authority', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-dither-preference-test', appVersion: 'test' });
    runtime.service.initialize();
    const durable: OrderedDitherPreferences = {
      current: { matrixSize: 8, coverage: 0.375, phaseX: 7, phaseY: 2 },
      presets: [{ id: 'preset-a', name: 'Fine shade', matrixSize: 8, coverage: 0.375, phaseX: 7, phaseY: 2 }],
      activePresetId: 'preset-a',
    };
    vi.spyOn(runtime.onionSkinPreferences, 'bootstrap').mockResolvedValue({ preferences: { ...DEFAULT_ONION_SKIN_PREFERENCES } });
    vi.spyOn(runtime.orderedDitherPreferences, 'bootstrap').mockResolvedValue({ preferences: durable, warning: 'Dither preference recovery advisory.' });
    vi.spyOn(runtime.spriteSymmetryPreferences, 'bootstrap').mockResolvedValue({ preferences: { mode: 'none', bindings: [] } });
    vi.spyOn(runtime.workspaceLayoutPreferences, 'bootstrap').mockResolvedValue({ preferences: { ...DEFAULT_WORKSPACE_LAYOUT_PREFERENCES } });
    await expect(runtime.editorBootstrap()).resolves.toMatchObject({ orderedDitherPreferences: durable, recoveryWarnings: ['Dither preference recovery advisory.'] });

    const save = vi.spyOn(runtime.orderedDitherPreferences, 'save').mockRejectedValueOnce(new Error('Injected replacement failure.')).mockResolvedValueOnce(durable);
    await expect(runtime.setOrderedDitherPreferences({ ...durable, current: { ...durable.current, phaseX: -1 } })).resolves.toEqual({
      saved: false, message: 'AIDraw rejected invalid ordered dither preferences; the saved preference was not changed.',
    });
    expect(save).not.toHaveBeenCalled();
    await expect(runtime.setOrderedDitherPreferences(durable)).resolves.toEqual({
      saved: false, message: 'Ordered dither settings changed in this editor, but AIDraw could not save them. The previous saved preference remains.',
    });
    await expect(runtime.setOrderedDitherPreferences(durable)).resolves.toEqual({ saved: true, preferences: durable });
  });

  it('hydrates and bounds complete workspace layout preference saves without exposing document authority', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-workspace-layout-test', appVersion: 'test' });
    runtime.service.initialize();
    const durable = { inspectorCollapsed: true, inspectorExpandedWidth: 472, mapSetupExpanded: true };
    vi.spyOn(runtime.onionSkinPreferences, 'bootstrap').mockResolvedValue({ preferences: { ...DEFAULT_ONION_SKIN_PREFERENCES } });
    vi.spyOn(runtime.orderedDitherPreferences, 'bootstrap').mockResolvedValue({ preferences: { current: { ...DEFAULT_ORDERED_DITHER_PREFERENCES.current }, presets: [], activePresetId: null } });
    vi.spyOn(runtime.spriteSymmetryPreferences, 'bootstrap').mockResolvedValue({ preferences: { mode: 'none', bindings: [] } });
    vi.spyOn(runtime.workspaceLayoutPreferences, 'bootstrap').mockResolvedValue({ preferences: durable, warning: 'Workspace layout recovery advisory.' });
    await expect(runtime.editorBootstrap()).resolves.toMatchObject({ workspaceLayoutPreferences: durable, recoveryWarnings: ['Workspace layout recovery advisory.'] });

    const save = vi.spyOn(runtime.workspaceLayoutPreferences, 'save')
      .mockRejectedValueOnce(new Error('Injected replacement failure.'))
      .mockResolvedValueOnce(durable);
    await expect(runtime.setWorkspaceLayoutPreferences({ ...durable, inspectorExpandedWidth: 521 })).resolves.toEqual({
      saved: false,
      message: 'AIDraw rejected invalid workspace layout preferences; the saved layout was not changed.',
    });
    expect(save).not.toHaveBeenCalled();
    await expect(runtime.setWorkspaceLayoutPreferences(durable)).resolves.toEqual({
      saved: false,
      message: 'Workspace layout changed in this editor, but AIDraw could not save it. The previous saved layout remains.',
    });
    await expect(runtime.setWorkspaceLayoutPreferences(durable)).resolves.toEqual({ saved: true, preferences: durable });
  });

  it('hydrates and bounds one complete shortcut mapping without exposing document authority', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-shortcut-preference-test', appVersion: 'test' });
    runtime.service.initialize();
    const assigned = assignShortcut(defaultShortcutPreferences(), 'toggle-inspector', 'Primary+B');
    if (!assigned.accepted) throw new Error(assigned.reason);
    const durable = assigned.preferences;
    vi.spyOn(runtime.onionSkinPreferences, 'bootstrap').mockResolvedValue({ preferences: { ...DEFAULT_ONION_SKIN_PREFERENCES } });
    vi.spyOn(runtime.orderedDitherPreferences, 'bootstrap').mockResolvedValue({ preferences: { current: { ...DEFAULT_ORDERED_DITHER_PREFERENCES.current }, presets: [], activePresetId: null } });
    vi.spyOn(runtime.spriteSymmetryPreferences, 'bootstrap').mockResolvedValue({ preferences: { mode: 'none', bindings: [] } });
    vi.spyOn(runtime.workspaceLayoutPreferences, 'bootstrap').mockResolvedValue({ preferences: { ...DEFAULT_WORKSPACE_LAYOUT_PREFERENCES } });
    vi.spyOn(runtime.shortcutPreferences, 'bootstrap').mockResolvedValue({ preferences: durable, warning: 'Shortcut recovery advisory.' });
    await expect(runtime.editorBootstrap()).resolves.toMatchObject({ shortcutPreferences: durable, recoveryWarnings: ['Shortcut recovery advisory.'] });

    const save = vi.spyOn(runtime.shortcutPreferences, 'save')
      .mockRejectedValueOnce(new Error('Injected replacement failure.'))
      .mockResolvedValueOnce(durable);
    const invalid = structuredClone(durable) as { bindings: Record<string, string> };
    delete invalid.bindings['tool:pixel:fill'];
    await expect(runtime.setShortcutPreferences(invalid)).resolves.toEqual({
      saved: false,
      message: 'AIDraw rejected invalid shortcut preferences; the saved mapping was not changed.',
    });
    expect(save).not.toHaveBeenCalled();
    await expect(runtime.setShortcutPreferences(durable)).resolves.toEqual({
      saved: false,
      message: 'Keyboard shortcuts changed in this editor, but AIDraw could not save them. The previous saved mapping remains.',
    });
    await expect(runtime.setShortcutPreferences(durable)).resolves.toEqual({ saved: true, preferences: durable });
  });

  it('coalesces concurrent callers and remains retryable until final recovery succeeds', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-stop-test', appVersion: 'test' });
    const state = runtime as unknown as { started: boolean };
    state.started = true;
    let releaseMcpStop!: () => void;
    const mcpStopRelease = new Promise<void>((resolve) => { releaseMcpStop = resolve; });
    const mcpStop = vi.spyOn(runtime.mcpHost, 'stop').mockImplementationOnce(async () => { await mcpStopRelease; }).mockResolvedValue(undefined);
    const flushPreferences = vi.spyOn(runtime.onionSkinPreferences, 'flush');
    const flushDitherPreferences = vi.spyOn(runtime.orderedDitherPreferences, 'flush');
    const flushSymmetryPreferences = vi.spyOn(runtime.spriteSymmetryPreferences, 'flush');
    const flushWorkspaceLayoutPreferences = vi.spyOn(runtime.workspaceLayoutPreferences, 'flush');
    const flushShortcutPreferences = vi.spyOn(runtime.shortcutPreferences, 'flush');
    vi.spyOn(runtime.rasterUtilities, 'stop').mockImplementation(() => undefined);
    vi.spyOn(runtime.generationUtilities, 'stop').mockImplementation(() => undefined);
    const compactRecovery = vi.spyOn(runtime.service, 'compactRecovery')
      .mockRejectedValueOnce(new Error('simulated final recovery failure'))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(runtime.service, 'setMcpInfo').mockImplementation(() => undefined);

    const first = runtime.stop();
    const concurrent = runtime.stop();
    await vi.waitFor(() => expect(mcpStop).toHaveBeenCalledOnce());
    releaseMcpStop();
    const failed = await Promise.allSettled([first, concurrent]);
    expect(failed.map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
    expect(compactRecovery).toHaveBeenCalledOnce();
    expect(flushPreferences).toHaveBeenCalledOnce();
    expect(flushDitherPreferences).toHaveBeenCalledOnce();
    expect(flushSymmetryPreferences).toHaveBeenCalledOnce();
    expect(flushWorkspaceLayoutPreferences).toHaveBeenCalledOnce();
    expect(flushShortcutPreferences).toHaveBeenCalledOnce();
    expect(state.started).toBe(true);

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(mcpStop).toHaveBeenCalledTimes(2);
    expect(flushPreferences).toHaveBeenCalledTimes(2);
    expect(flushDitherPreferences).toHaveBeenCalledTimes(2);
    expect(flushSymmetryPreferences).toHaveBeenCalledTimes(2);
    expect(flushWorkspaceLayoutPreferences).toHaveBeenCalledTimes(2);
    expect(flushShortcutPreferences).toHaveBeenCalledTimes(2);
    expect(compactRecovery).toHaveBeenCalledTimes(2);
    expect(state.started).toBe(false);

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(mcpStop).toHaveBeenCalledTimes(2);
  });

  it('publishes a persisted replacement before retiring sessions and keeps the endpoint running', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-rotate-test', appVersion: 'test' });
    const state = runtime as unknown as {
      started: boolean;
      mcpCredentials: { rotate(): Promise<string> };
    };
    state.started = true;
    const token = Buffer.alloc(32, 0x31).toString('base64url');
    const order: string[] = [];
    vi.spyOn(state.mcpCredentials, 'rotate').mockImplementation(async () => { order.push('persisted'); return token; });
    vi.spyOn(runtime.mcpHost, 'credentials').mockReturnValue({ url: 'http://127.0.0.1:48200/mcp', token: 'not-observed' });
    vi.spyOn(runtime.mcpHost, 'replaceCredential').mockImplementation(async () => { order.push('retired'); return 2; });
    const setMcpInfo = vi.spyOn(runtime.service, 'setMcpInfo').mockImplementation(() => undefined);

    await expect(runtime.rotateMcpCredential()).resolves.toEqual({ access: 'active', endpointRunning: true, sessionsTerminated: 2 });
    expect(order).toEqual(['persisted', 'retired']);
    expect(setMcpInfo).toHaveBeenCalledWith({
      running: true,
      access: 'active',
      url: 'http://127.0.0.1:48200/mcp',
      port: 48_200,
      tokenHint: 'Credential active',
    });
  });

  it('persists revocation before disabling authentication and stopping only MCP access', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-revoke-test', appVersion: 'test' });
    const state = runtime as unknown as {
      started: boolean;
      mcpCredentials: { revoke(): Promise<void> };
    };
    state.started = true;
    const order: string[] = [];
    vi.spyOn(state.mcpCredentials, 'revoke').mockImplementation(async () => { order.push('persisted'); });
    vi.spyOn(runtime.mcpHost, 'revokeCredential').mockImplementation(async () => { order.push('authentication-disabled'); return 3; });
    vi.spyOn(runtime.mcpHost, 'stop').mockImplementation(async () => { order.push('endpoint-stopped'); });
    const setMcpInfo = vi.spyOn(runtime.service, 'setMcpInfo').mockImplementation(() => undefined);

    await expect(runtime.revokeMcpAccess()).resolves.toEqual({ access: 'revoked', endpointRunning: false, sessionsTerminated: 3 });
    expect(order).toEqual(['persisted', 'authentication-disabled', 'endpoint-stopped']);
    expect(setMcpInfo).toHaveBeenCalledWith({ running: false, access: 'revoked', tokenHint: 'Access revoked' });
    expect(state.started).toBe(true);
  });

  it('keeps persisted revocation fail closed and reports current truth when endpoint cleanup fails', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-revoke-cleanup-failure-test', appVersion: 'test' });
    const state = runtime as unknown as {
      started: boolean;
      mcpCredentials: { revoke(): Promise<void> };
    };
    state.started = true;
    const order: string[] = [];
    vi.spyOn(state.mcpCredentials, 'revoke').mockImplementation(async () => { order.push('persisted'); });
    vi.spyOn(runtime.mcpHost, 'revokeCredential').mockImplementation(async () => { order.push('authentication-disabled'); return 2; });
    vi.spyOn(runtime.mcpHost, 'stop').mockImplementation(async () => { order.push('cleanup-failed'); throw new Error('injected endpoint cleanup failure'); });
    vi.spyOn(runtime.mcpHost, 'credentials').mockReturnValue({ url: 'http://127.0.0.1:48201/mcp', token: '' });
    const setMcpInfo = vi.spyOn(runtime.service, 'setMcpInfo').mockImplementation(() => undefined);

    await expect(runtime.revokeMcpAccess()).resolves.toEqual({
      access: 'revoked',
      endpointRunning: true,
      sessionsTerminated: 2,
      cleanupWarning: 'MCP access was revoked and every bearer remains invalid, but the local endpoint could not be fully stopped. Restart AIDraw before re-enabling access.',
    });
    expect(order).toEqual(['persisted', 'authentication-disabled', 'cleanup-failed']);
    expect(setMcpInfo).toHaveBeenCalledWith({
      running: true,
      access: 'revoked',
      url: 'http://127.0.0.1:48201/mcp',
      port: 48_201,
      tokenHint: 'Access revoked',
    });
    expect(state.started).toBe(true);
  });

  it('leaves runtime authentication and the endpoint untouched when persistence fails', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-credential-failure-test', appVersion: 'test' });
    const state = runtime as unknown as {
      started: boolean;
      mcpCredentials: { rotate(): Promise<string>; revoke(): Promise<void> };
    };
    state.started = true;
    vi.spyOn(state.mcpCredentials, 'rotate').mockRejectedValue(new Error('Injected rotation persistence failure.'));
    const replaceCredential = vi.spyOn(runtime.mcpHost, 'replaceCredential');
    const start = vi.spyOn(runtime.mcpHost, 'start');
    await expect(runtime.rotateMcpCredential()).rejects.toThrow('Injected rotation persistence failure.');
    expect(replaceCredential).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();

    vi.spyOn(state.mcpCredentials, 'revoke').mockRejectedValue(new Error('Injected revocation persistence failure.'));
    const revokeCredential = vi.spyOn(runtime.mcpHost, 'revokeCredential');
    const stop = vi.spyOn(runtime.mcpHost, 'stop');
    await expect(runtime.revokeMcpAccess()).rejects.toThrow('Injected revocation persistence failure.');
    expect(revokeCredential).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('honors persisted revocation on restart without creating an endpoint', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-engine-revoked-start-'));
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'test' });
    const state = runtime as unknown as {
      mcpCredentials: { loadOrCreate(): Promise<{ status: 'revoked' }> };
    };
    vi.spyOn(state.mcpCredentials, 'loadOrCreate').mockResolvedValue({ status: 'revoked' });
    const start = vi.spyOn(runtime.mcpHost, 'start');
    try {
      await runtime.start();
      expect(start).not.toHaveBeenCalled();
      expect(runtime.service.getMcpInfo()).toMatchObject({
        running: false,
        access: 'revoked',
        tokenHint: 'Access revoked',
        sessions: [],
      });
    } finally {
      await runtime.stop();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
