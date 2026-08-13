import boldSource from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?inline';
import boldItalicSource from 'pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf?inline';
import italicSource from 'pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf?inline';
import regularSource from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?inline';
import { BUNDLED_CANVAS_FALLBACK_FAMILY } from './canvas-font';

export interface BundledCanvasFontFace {
  fileName: string;
  source: string;
  style: 'normal' | 'italic';
  weight: 400 | 700;
  sha256: string;
}

export const BUNDLED_CANVAS_FONT_FAMILY = BUNDLED_CANVAS_FALLBACK_FAMILY;

export const BUNDLED_CANVAS_FONT_FACES: readonly BundledCanvasFontFace[] = [
  { fileName: 'LiberationSans-Regular.ttf', source: regularSource, style: 'normal', weight: 400, sha256: 'f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f' },
  { fileName: 'LiberationSans-Bold.ttf', source: boldSource, style: 'normal', weight: 700, sha256: '361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc' },
  { fileName: 'LiberationSans-Italic.ttf', source: italicSource, style: 'italic', weight: 400, sha256: '832b4406dbef23628800d3aaad21048534ac84d7e3ad955be83b8172ed8ef512' },
  { fileName: 'LiberationSans-BoldItalic.ttf', source: boldItalicSource, style: 'italic', weight: 700, sha256: 'a224075ac17495ad0a3af3bc0a419ac0704a8b3fd1095456201fb9b095fc281d' },
];
