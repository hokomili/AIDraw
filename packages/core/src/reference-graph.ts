export function assertAcyclicReferences<T>(
  entries: Record<string, T>,
  referencesFor: (entry: T) => readonly string[],
  cycleError: string,
): void {
  const states = new Map<string, 'visiting' | 'done'>();
  const referencesForId = (entryId: string): readonly string[] => referencesFor(entries[entryId]);
  for (const entryId of Object.keys(entries)) {
    if (states.get(entryId) === 'done') continue;
    const stack: Array<{ id: string; references: readonly string[]; referenceIndex: number }> = [{ id: entryId, references: referencesForId(entryId), referenceIndex: 0 }];
    while (stack.length) {
      const current = stack.at(-1)!; states.set(current.id, 'visiting');
      if (current.referenceIndex >= current.references.length) { states.set(current.id, 'done'); stack.pop(); continue; }
      const referenceId = current.references[current.referenceIndex]; current.referenceIndex += 1;
      if (states.get(referenceId) === 'visiting') throw new Error(cycleError);
      if (states.get(referenceId) !== 'done' && entries[referenceId] !== undefined) stack.push({ id: referenceId, references: referencesForId(referenceId), referenceIndex: 0 });
    }
  }
}
