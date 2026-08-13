import { describe, expect, it, vi } from 'vitest';
import { EngineRuntime } from '@main/engine-runtime';

describe('EngineRuntime stop', () => {
  it('coalesces concurrent callers and remains retryable until final recovery succeeds', async () => {
    const runtime = new EngineRuntime({ userDataPath: '/private/aidraw-engine-stop-test', appVersion: 'test' });
    const state = runtime as unknown as { started: boolean };
    state.started = true;
    let releaseMcpStop!: () => void;
    const mcpStopRelease = new Promise<void>((resolve) => { releaseMcpStop = resolve; });
    const mcpStop = vi.spyOn(runtime.mcpHost, 'stop').mockImplementationOnce(async () => { await mcpStopRelease; }).mockResolvedValue(undefined);
    vi.spyOn(runtime.rasterUtilities, 'stop').mockImplementation(() => undefined);
    vi.spyOn(runtime.generationUtilities, 'stop').mockImplementation(() => undefined);
    const compactRecovery = vi.spyOn(runtime.service, 'compactRecovery')
      .mockRejectedValueOnce(new Error('simulated final recovery failure'))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(runtime.service, 'setMcpInfo').mockImplementation(() => undefined);

    const first = runtime.stop();
    const concurrent = runtime.stop();
    expect(mcpStop).toHaveBeenCalledOnce();
    releaseMcpStop();
    const failed = await Promise.allSettled([first, concurrent]);
    expect(failed.map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
    expect(compactRecovery).toHaveBeenCalledOnce();
    expect(state.started).toBe(true);

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(mcpStop).toHaveBeenCalledTimes(2);
    expect(compactRecovery).toHaveBeenCalledTimes(2);
    expect(state.started).toBe(false);

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(mcpStop).toHaveBeenCalledTimes(2);
  });
});
