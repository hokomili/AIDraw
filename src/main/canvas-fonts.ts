import { GlobalFonts } from '@napi-rs/canvas';
import { BUNDLED_CANVAS_FONT_FACES, BUNDLED_CANVAS_FONT_FAMILY } from '../common/bundled-canvas-font';

interface NativeCanvasFontRegistry {
  register(font: Buffer, nameAlias?: string): unknown | null;
}

function fontBytes(source: string): Buffer {
  const marker = ';base64,';
  const markerIndex = source.indexOf(marker);
  if (!source.startsWith('data:') || markerIndex < 0) throw new Error('Bundled Canvas font is not an inline base64 asset.');
  const bytes = Buffer.from(source.slice(markerIndex + marker.length), 'base64');
  if (!bytes.length) throw new Error('Bundled Canvas font asset is empty.');
  return bytes;
}

export function registerBundledNativeCanvasFonts(registry: NativeCanvasFontRegistry = GlobalFonts): void {
  for (const face of BUNDLED_CANVAS_FONT_FACES) {
    if (!registry.register(fontBytes(face.source), BUNDLED_CANVAS_FONT_FAMILY)) throw new Error(`Could not register bundled Canvas font ${face.fileName}.`);
  }
}

let registered = false;

export function ensureBundledNativeCanvasFonts(): void {
  if (registered) return;
  registerBundledNativeCanvasFonts();
  registered = true;
}
