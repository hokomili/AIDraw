import { describe, expect, it } from 'vitest';
import { flattenLayerTree, moveLayerTreeEntry, type LayerTreeEntry } from '../../src/common/layer-tree';

const entries = (): Record<string, LayerTreeEntry> => ({
  bottom: { id: 'bottom', type: 'tile' },
  group: { id: 'group', type: 'group', childIds: ['child'] },
  child: { id: 'child', type: 'group', parentId: 'group', childIds: [] },
  top: { id: 'top', type: 'tile' },
});

describe('layer tree geometry', () => {
  it('flattens visual z-order with real nesting and collapse', () => { expect(flattenLayerTree(entries(), ['bottom', 'group', 'top']).map(({ entry, depth }) => [entry.id, depth])).toEqual([['top', 0], ['group', 0], ['child', 1], ['bottom', 0]]); expect(flattenLayerTree(entries(), ['bottom', 'group', 'top'], new Set(['group'])).map(({ entry }) => entry.id)).toEqual(['top', 'group', 'bottom']); });
  it('moves a root into a group at an exact storage index', () => { const moved = moveLayerTreeEntry(entries(), ['bottom', 'group', 'top'], 'top', 'group', 0); expect(moved.rootIds).toEqual(['bottom', 'group']); expect(moved.entries.group.childIds).toEqual(['top', 'child']); expect(moved.entries.top.parentId).toBe('group'); });
  it('rejects cycles', () => { expect(() => moveLayerTreeEntry(entries(), ['bottom', 'group', 'top'], 'group', 'child')).toThrow(/descendants/); });
});
