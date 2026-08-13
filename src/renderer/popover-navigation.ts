export function menuFocusIndex(
  key: string,
  currentIndex: number,
  count: number,
): number | undefined {
  if (count <= 0) return undefined;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return currentIndex < 0 ? 0 : (currentIndex + 1) % count;
  if (key === 'ArrowUp') return currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count;
  return undefined;
}
