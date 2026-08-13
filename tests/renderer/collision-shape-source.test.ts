import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('collision multi-selection source wiring', () => {
  it('uses the shared group-move kernel, bounded crop sampling, additive selection, and cancel-without-commit', async () => {
    const source = await readFile(new URL('../../src/renderer/components/CollisionShapeEditor.tsx', import.meta.url), 'utf8');
    expect(source).toContain('moveMapObjectSelection');
    expect(source).toContain('drawSpriteRegionThumbnail');
    expect(source).toContain('240 / Math.max(1, props.width)');
    expect(source).toContain('200 / Math.max(1, props.height)');
    expect(source).toContain('event.shiftKey');
    expect(source).toContain('selectedIds.length === 1');
    expect(source).toContain('`Move ${changed.length} collisions`');
    expect(source).toContain('onPointerCancel={(event) => void finishGesture(event, false)}');
    expect(source).not.toContain('for (let y = 0; y < props.height');
  });

  it('exposes checkboxes, select-all, clear, and one revision-checked bulk delete/replace surface', async () => {
    const source = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('selectedCollisionIds');
    expect(source).toContain('Select all');
    expect(source).toContain('Delete selected');
    expect(source).toContain('{"Select collision " + (shapeIndex + 1)}');
    expect(source).toContain('setSelectedCollisionIds(event.shiftKey');
    expect(source).toContain('const changed = new Map(shapes.map((shape) => [shape.id, shape]))');
    expect(source).toContain('kind: "pixel.asset.replace"');
    expect(source).toContain('expectedRevision: tileset.revision');
  });
});
