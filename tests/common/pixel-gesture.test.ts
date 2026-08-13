import { describe, expect, it } from 'vitest';
import { cancelPixelGesture, releasePendingPixelLocks, type PendingPixelLockResult } from '../../src/common/pixel-gesture';

describe('pixel gesture cancellation', () => {
  it('clears draft state synchronously and releases a duplicated pending lock once', async () => {
    const events: string[] = [];
    let resolveLock!: (value: PendingPixelLockResult) => void;
    const pending = new Promise<PendingPixelLockResult>((resolve) => { resolveLock = resolve; });
    const cancelled = cancelPixelGesture(
      () => events.push('cleared'),
      [pending, pending],
      async (lockId) => { events.push(`released:${lockId}`); },
    );
    expect(events).toEqual(['cleared']);
    resolveLock({ acquired: true, lockId: 'pixel-lock' });
    await cancelled;
    expect(events).toEqual(['cleared', 'released:pixel-lock']);
  });

  it('deduplicates resolved lock IDs and contains acquisition and release failures', async () => {
    const released: string[] = [];
    await expect(releasePendingPixelLocks([
      Promise.resolve({ acquired: true, lockId: 'same-lock' }),
      Promise.resolve({ acquired: true, lockId: 'same-lock' }),
      Promise.resolve({ acquired: false }),
      Promise.reject(new Error('acquisition failed')),
    ], async (lockId) => {
      released.push(lockId);
      throw new Error('release failed');
    })).resolves.toBeUndefined();
    expect(released).toEqual(['same-lock']);
  });
});
