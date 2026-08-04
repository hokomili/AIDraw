export function splitColorAlpha(color: string): { color: string; opacity: number } {
  const normalized = color.trim();
  if (/^#[0-9a-f]{8}$/i.test(normalized)) return { color: normalized.slice(0, 7), opacity: Number.parseInt(normalized.slice(7, 9), 16) / 255 };
  return { color: normalized, opacity: 1 };
}

export function colorWithOpacity(color: string, opacity = 1): string {
  const split = splitColorAlpha(color); const alpha = Math.max(0, Math.min(1, split.opacity * opacity));
  if (!/^#[0-9a-f]{6}$/i.test(split.color)) return color;
  return `rgba(${Number.parseInt(split.color.slice(1, 3), 16)}, ${Number.parseInt(split.color.slice(3, 5), 16)}, ${Number.parseInt(split.color.slice(5, 7), 16)}, ${alpha})`;
}
