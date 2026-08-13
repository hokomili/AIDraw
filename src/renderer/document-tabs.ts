export function documentTabFocusIndex(
  key: string,
  currentIndex: number,
  count: number,
): number | undefined {
  if (count <= 0) return undefined;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowRight') return currentIndex < 0 ? 0 : (currentIndex + 1) % count;
  if (key === 'ArrowLeft') return currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count;
  return undefined;
}
