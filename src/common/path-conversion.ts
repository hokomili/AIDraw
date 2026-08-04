import paper from 'paper';

export function convertPathArcsToCubics(pathData: string): { pathData: string; closed: boolean } {
  if (typeof pathData !== 'string' || pathData.length < 3 || pathData.length > 1_000_000) throw new Error('Path data is empty or exceeds the one-million-character conversion limit.');
  const scope = new paper.PaperScope(); scope.setup(new scope.Size(1, 1));
  try {
    const item = scope.PathItem.create(pathData); if (!item) throw new Error('Path data could not be parsed.');
    if (item.className !== 'Path') throw new Error('Arc conversion currently supports one simple subpath.');
    const path = item as paper.Path; const converted = path.pathData; if (!converted) throw new Error('Path conversion produced no geometry.');
    return { pathData: converted, closed: path.closed };
  } finally { scope.project.remove(); }
}
