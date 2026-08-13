import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { documentTabFocusIndex } from '../../src/renderer/document-tabs';

describe('document-tab keyboard navigation', () => {
  it('wraps horizontal focus and resolves Home and End deterministically', () => {
    expect(documentTabFocusIndex('ArrowRight', 2, 3)).toBe(0);
    expect(documentTabFocusIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(documentTabFocusIndex('Home', 2, 3)).toBe(0);
    expect(documentTabFocusIndex('End', 0, 3)).toBe(2);
    expect(documentTabFocusIndex('Enter', 0, 3)).toBeUndefined();
    expect(documentTabFocusIndex('ArrowRight', -1, 0)).toBeUndefined();
  });

  it('wires one active tab stop, automatic activation, and a sibling close button', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('documentTabFocusIndex(');
    expect(app).toContain('role="tablist"');
    expect(app).toContain('aria-label="Open documents"');
    expect(app).toContain('tabIndex={active ? 0 : -1}');
    expect((app.match(/tabIndex=\{active \? 0 : -1\}/gu) ?? [])).toHaveLength(2);
    expect(app).toContain('void activate(documents[nextIndex].id)');
    expect(app).toContain('className={`document-tab-shell');
    expect(app).toContain('role="presentation"');
    expect(app).toContain('className="tab-close"');
    expect(app).toContain('closeDocumentTab(document.id, active)');
    expect(app).toContain('.document-tab[tabindex="0"]');
    expect(app).not.toMatch(/<span\s+role="button"\s+tabIndex=\{0\}\s+className="tab-close"/u);
  });
});
