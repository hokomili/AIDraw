import { CanvasOperationSchema, createId, type BitmapFont } from '@aidraw/core';

/** Parse one bounded, document-portable bitmap font without trusting a cast. */
export function parseBitmapFontJson(text: string, existingIds: Iterable<string> = []): BitmapFont {
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new Error('Bitmap font JSON is limited to 1 MiB.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Bitmap font JSON is malformed.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Bitmap font JSON must contain an object.');
  const candidate = 'font' in parsed ? (parsed as { font?: unknown }).font : parsed;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('The file does not contain a bitmap font.');
  const imported = structuredClone(candidate) as Partial<BitmapFont>;
  const ids = new Set(existingIds); const requestedId = typeof imported.id === 'string' ? imported.id : '';
  const next = { ...imported, id: !requestedId || ids.has(requestedId) ? createId('bitmap-font') : requestedId } as BitmapFont;
  const validation = CanvasOperationSchema.safeParse({ kind: 'pixel.bitmap-fonts.replace', fonts: [next] });
  if (!validation.success) throw new Error(validation.error.issues[0]?.message ?? 'The bitmap font is invalid.');
  return next;
}
