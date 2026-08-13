import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GracefulShutdownCoordinator } from '@main/graceful-shutdown';

describe('graceful application shutdown', () => {
  it('prevents repeated quit events until one shared engine stop completes', async () => {
    let releaseStop!: () => void;
    const stopRelease = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stopEngine = vi.fn(async () => { await stopRelease; });
    const quitApplication = vi.fn();
    const reportFailure = vi.fn();
    const coordinator = new GracefulShutdownCoordinator({ stopEngine, quitApplication, reportFailure });
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    coordinator.handleBeforeQuit(firstEvent);
    coordinator.handleBeforeQuit(secondEvent);
    const pending = coordinator.requestQuit();
    await Promise.resolve();
    expect(coordinator.isQuitPending()).toBe(true);
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(stopEngine).toHaveBeenCalledOnce();
    expect(quitApplication).not.toHaveBeenCalled();

    releaseStop();
    await pending;
    expect(coordinator.isComplete()).toBe(true);
    expect(coordinator.isQuitPending()).toBe(false);
    expect(quitApplication).toHaveBeenCalledOnce();
    expect(reportFailure).not.toHaveBeenCalled();

    const finalEvent = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(quitApplication).toHaveBeenCalledOnce();
  });

  it('keeps quit cancelled after stop failure and retries on the next request', async () => {
    const stopEngine = vi.fn()
      .mockRejectedValueOnce(new Error('simulated final compaction failure'))
      .mockResolvedValueOnce(undefined);
    const quitApplication = vi.fn();
    const coordinator = new GracefulShutdownCoordinator({ stopEngine, quitApplication, reportFailure: vi.fn() });

    await expect(coordinator.requestQuit()).rejects.toThrow('simulated final compaction failure');
    expect(coordinator.isComplete()).toBe(false);
    expect(coordinator.isQuitPending()).toBe(false);
    expect(quitApplication).not.toHaveBeenCalled();

    await expect(coordinator.requestQuit()).resolves.toBeUndefined();
    expect(stopEngine).toHaveBeenCalledTimes(2);
    expect(coordinator.isComplete()).toBe(true);
    expect(quitApplication).toHaveBeenCalledOnce();
  });

  it('reports one failure for repeated operating-system quit events', async () => {
    const reportFailure = vi.fn();
    const coordinator = new GracefulShutdownCoordinator({
      stopEngine: vi.fn().mockRejectedValue(new Error('simulated shutdown failure')),
      quitApplication: vi.fn(),
      reportFailure,
    });
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    coordinator.handleBeforeQuit(firstEvent);
    coordinator.handleBeforeQuit(secondEvent);
    await vi.waitFor(() => { expect(reportFailure).toHaveBeenCalledOnce(); });
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it('routes both explicit and operating-system quit through the coordinator', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/main.ts'), 'utf8');
    expect(source).toContain('await gracefulShutdown.requestQuit();');
    expect(source).toContain("app.on('before-quit', (event) => { gracefulShutdown.handleBeforeQuit(event); });");
    expect(source).not.toContain('void engineRuntime?.stop()');
  });
});
