export interface PendingPixelLockResult {
  acquired: boolean;
  lockId?: string;
}

export async function releasePendingPixelLocks(
  pendingLocks: readonly Promise<PendingPixelLockResult>[],
  releaseLock: (lockId: string) => Promise<unknown>,
): Promise<void> {
  const settled = await Promise.all([...new Set(pendingLocks)].map((pending) => pending.catch(() => undefined)));
  const lockIds = [...new Set(settled.flatMap((lock) => lock?.lockId ? [lock.lockId] : []))];
  await Promise.all(lockIds.map((lockId) => releaseLock(lockId).catch(() => undefined)));
}

/** Clears draft state synchronously, then releases any lock that eventually resolves. */
export function cancelPixelGesture(
  clearDraft: () => void,
  pendingLocks: readonly Promise<PendingPixelLockResult>[],
  releaseLock: (lockId: string) => Promise<unknown>,
): Promise<void> {
  clearDraft();
  return releasePendingPixelLocks(pendingLocks, releaseLock);
}
