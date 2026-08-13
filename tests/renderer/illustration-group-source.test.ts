import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('illustration group renderer wiring', () => {
  it('shares transform detection and effect-isolation policy across interactive and headless Canvas traversal', () => {
    const interactive = readFileSync(new URL('../../src/renderer/canvas/IllustrationCanvas.tsx', import.meta.url), 'utf8');
    const headless = readFileSync(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    for (const source of [interactive, headless]) {
      expect(source).toContain('illustrationGroupRequiresIsolation');
      expect(source).toContain('illustrationObjectHasTransform');
      expect(source).toContain('const transformed = illustrationObjectHasTransform(object); const isolate = illustrationGroupRequiresIsolation(object);');
      expect(source).toMatch(/if \(!isolate\) \{[\s\S]*if \(transformed\)[\s\S]*for \(const childId of object\.childIds\)/);
    }
  });
});
