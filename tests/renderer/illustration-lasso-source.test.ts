import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../src/renderer/canvas/IllustrationCanvas.tsx', import.meta.url), 'utf8');

describe('illustration lasso source wiring', () => {
  it('loads canonical geometry on pointer completion and preserves selection combination modes', () => {
    expect(source).toContain("await import('../../common/illustration-lasso')");
    expect(source).toContain('lassoSelectsIllustrationObjects(polygon, Object.values(document.objects), Boolean(gesture.containment))');
    expect(source).toContain("combineSelection(selectedIds, ids, gesture.selectionCombination ?? 'replace')");
    expect(source).not.toContain('lassoSelectsBounds(polygon, objectWorldBounds(object)');
  });
});
