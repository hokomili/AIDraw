import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createIllustrationDocument, type GroupObject, type TextObject } from '@aidraw/core';
import { illustrationTextEditorStyle, illustrationTextObjectIsEditable } from '../../src/renderer/canvas/illustration-text-editor';

const timestamp = '2026-08-13T00:00:00.000Z';

function textObject(): TextObject {
  return {
    id: 'text-1', revision: 3, name: 'Caption', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    layerId: 'layer-1', visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 3, y: 4 },
    type: 'text', text: 'Hello', width: 300, height: 80, align: 'right', lineHeight: 1.4,
    ranges: [{ start: 0, end: 5, fontFamily: 'Missing face', fontSize: 24, fontWeight: 700, fontStyle: 'italic', color: '#123456', letterSpacing: 2, underline: true }],
  };
}

describe('illustration in-canvas text editor', () => {
  it('maps the canonical object box and first text style into viewport CSS', () => {
    const document = createIllustrationDocument('Inline text');
    const object = textObject();
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Missing vector layer');
    object.layerId = layer.id;
    document.objects[object.id] = object;
    layer.objectIds.push(object.id);
    const style = illustrationTextEditorStyle(document, object, { scale: 2, offsetX: 10, offsetY: 20 });
    expect(style).toMatchObject({
      width: 300,
      height: 80,
      transform: 'matrix(2, 0, 0, 2, 16, 28)',
      transformOrigin: '0 0',
      font: 'italic 700 24px "Missing face", "AIDraw Liberation Sans"',
      lineHeight: 1.4,
      letterSpacing: '2px',
      color: '#123456',
      textAlign: 'right',
      textDecoration: 'underline',
    });

    const group: GroupObject = {
      ...object,
      id: 'group-1',
      name: 'Rotated group',
      type: 'group',
      transform: { ...IDENTITY_TRANSFORM, x: 10, y: 20, rotation: 90 },
      childIds: [object.id],
    };
    document.objects[group.id] = group;
    layer.objectIds.push(group.id);
    expect(illustrationTextEditorStyle(document, object, { scale: 2, offsetX: 10, offsetY: 20 }).transform)
      .toBe('matrix(0, 2, -2, 0, 22, 66)');
    expect(illustrationTextObjectIsEditable(document, object)).toBe(true);
    group.locked = true;
    expect(illustrationTextObjectIsEditable(document, object)).toBe(false);
    group.locked = false;
    layer.visible = false;
    expect(illustrationTextObjectIsEditable(document, object)).toBe(false);
    layer.visible = true;
    layer.objectIds = layer.objectIds.filter((id) => id !== group.id);
    expect(illustrationTextObjectIsEditable(document, object)).toBe(false);
  });

  it('keeps content editing wired to explicit open, commit, and cancel paths', () => {
    const source = readFileSync(new URL('../../src/renderer/canvas/IllustrationCanvas.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(source).toContain('event.detail >= 2 && illustrationTextObjectIsEditable(document, object)');
    expect(source).toContain("event.key === 'Enter' && tool === 'select'");
    expect(source).toContain("replaceStyledText(session.object, session.draft)");
    expect(source).toContain('illustrationTextObjectIsEditable(currentDocument, currentObject)');
    expect(source).toContain('maxLength={MAX_ILLUSTRATION_TEXT_LENGTH}');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("event.key === 'Enter' && (event.ctrlKey || event.metaKey)");
    expect(source).toContain('onBlur={() => void commitTextEdit()}');
    expect(source).toContain("gesture.kind === 'move' && gesture.start.x === gesture.end.x && gesture.start.y === gesture.end.y");
    expect(styles).toContain('.illustration-text-editor');
  });
});
