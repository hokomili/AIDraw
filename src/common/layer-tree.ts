export interface LayerTreeEntry {
  id: string;
  type: string;
  parentId?: string;
  childIds?: string[];
}

export function flattenLayerTree<T extends LayerTreeEntry>(entries: Record<string, T>, rootIds: string[], collapsed = new Set<string>()): Array<{ entry: T; depth: number }> {
  const result: Array<{ entry: T; depth: number }> = []; const visited = new Set<string>();
  const hide = (id: string) => { if (visited.has(id)) return; visited.add(id); for (const childId of entries[id]?.childIds ?? []) hide(childId); };
  const visit = (id: string, depth: number) => { const entry = entries[id]; if (!entry || visited.has(id)) return; visited.add(id); result.push({ entry, depth }); if (entry.type === 'group') { if (collapsed.has(id)) for (const childId of entry.childIds ?? []) hide(childId); else for (const childId of [...(entry.childIds ?? [])].reverse()) visit(childId, depth + 1); } };
  for (const id of [...rootIds].reverse()) visit(id, 0);
  for (const entry of Object.values(entries)) if (!visited.has(entry.id)) visit(entry.id, 0);
  return result;
}

export function layerTreeDescendants<T extends LayerTreeEntry>(entries: Record<string, T>, id: string): Set<string> {
  const result = new Set<string>(); const visit = (currentId: string) => { if (result.has(currentId)) return; result.add(currentId); for (const childId of entries[currentId]?.childIds ?? []) visit(childId); }; for (const childId of entries[id]?.childIds ?? []) visit(childId); return result;
}

export function moveLayerTreeEntry<T extends LayerTreeEntry>(entries: Record<string, T>, rootIds: string[], id: string, parentId?: string, index?: number): { entries: Record<string, T>; rootIds: string[] } {
  if (!entries[id]) throw new Error(`Layer ${id} does not exist.`);
  if (parentId) { const parent = entries[parentId]; if (!parent || parent.type !== 'group') throw new Error(`Layer ${parentId} is not a group.`); if (parentId === id || layerTreeDescendants(entries, id).has(parentId)) throw new Error('A layer cannot move into itself or one of its descendants.'); }
  const next = structuredClone(entries); const roots = rootIds.filter((entryId) => entryId !== id);
  for (const entry of Object.values(next)) if (entry.childIds) entry.childIds = entry.childIds.filter((entryId) => entryId !== id);
  next[id].parentId = parentId;
  const siblings = parentId ? next[parentId].childIds ?? (next[parentId].childIds = []) : roots; const insertion = Math.max(0, Math.min(index ?? siblings.length, siblings.length)); siblings.splice(insertion, 0, id);
  return { entries: next, rootIds: roots };
}
