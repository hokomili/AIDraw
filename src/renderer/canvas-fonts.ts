import { BUNDLED_CANVAS_FONT_FACES, BUNDLED_CANVAS_FONT_FAMILY } from '../common/bundled-canvas-font';

interface BrowserCanvasFontSet {
  add(face: FontFace): unknown;
}

export async function loadBundledBrowserCanvasFonts(
  fontSet: BrowserCanvasFontSet,
  FontFaceConstructor: typeof FontFace,
): Promise<void> {
  const faces = BUNDLED_CANVAS_FONT_FACES.map((face) => new FontFaceConstructor(
    BUNDLED_CANVAS_FONT_FAMILY,
    `url("${face.source}")`,
    { style: face.style, weight: String(face.weight) },
  ));
  await Promise.all(faces.map((face) => face.load()));
  for (const face of faces) fontSet.add(face);
}

let loading: Promise<void> | undefined;

export function ensureBundledBrowserCanvasFonts(): Promise<void> {
  loading ??= loadBundledBrowserCanvasFonts(document.fonts, FontFace);
  return loading;
}
