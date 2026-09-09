/** Runtime preconditions supplement JSON Schema; discovery never grants authority. */
export function operationPreconditions(kind: string): string[] {
  const common = [
    'Read canvas_observe first. Use observed document/entity IDs and revisions, a new unique ID for new entities, and a stable clientOperationId for an exact retry only.',
    'Submit the payload inside canvas_apply.operations. Human locks, document incarnation, reference integrity, resource limits, and canonical transaction validation still apply.',
    'For complete replacements, copy the observed record and change only the intended fields. Actor identity, revisions and timestamps are server-owned even where compatibility schemas accept them.',
  ];
  const rules: Record<string, string[]> = {
    'illustration.gradient.set': [
      'Select a path or filled shape. Coordinates x1/y1/x2/y2 are local object pixels, before its transform; they are not normalized 0–1 coordinates.',
      'For linear-gradient, endpoints define the gradient line. For radial-gradient, x1/y1 is the center and x2/y2 is a point on its radius; both Canvas circles share that center. A zero radial radius uses the final stop color.',
      'Supply 2–32 stops with ordered offsets in 0–1. Stop opacity multiplies color alpha. expectedRevision is the target object revision.',
    ],
    'illustration.path.boolean': [
      'Supply exactly two compatible paths, rectangles, ellipses, polygons, or stars in one writable vector layer. expectedRevisions maps both object IDs to their observed revisions. Transforms are applied to the geometry.',
      'Only nonempty results that fit the current editable one-simple-subpath envelope can commit. Disjoint outlines or holes can produce multiple subpaths for any mode, including exclude; those results are unsupported and leave both operands unchanged. Do not retry unchanged geometry.',
      'A successful operation atomically replaces both operands with one editable path using the first operand’s fill/stroke and the result fill rule. General compound-path editing is not supported.',
    ],
    'illustration.object.move': [
      'layerId is the destination vector layer. Populated object groups can move only within their existing vector layer. This operation does not transfer a group subtree between layers.',
      'Single objects and empty groups may move between vector layers if mask/reference and lock constraints permit. Clear dependent masks deliberately before moving a referenced mask to another layer.',
      'parentGroupId must name an existing group in the destination layer; groupIndex is valid only with parentGroupId. Cycles are refused. A capability limit is not a transient revision conflict.',
    ],
    'illustration.image.crop': ['rectangle is in displayed image-local pixels; aspect is width divided by height. action=rectangle requires rectangle only; action=aspect requires aspect only; action=reset accepts neither.'],
    'illustration.text.style': ['start is inclusive and end is exclusive, in JavaScript UTF-16 text positions. Cover the complete intended text range; a shorter range leaves the remaining text style unchanged.'],
    'illustration.path.join': ['Use two distinct paths in one layer; expectedRevisions must include both IDs. endpoints selects the endpoint pair; nearest chooses the closest pair. The joined result must remain within supported single-subpath limits.'],
    'illustration.object.mask.set': ['objectIds names the masked objects; maskObjectId is a same-layer compatible mask, or null to clear it. expectedRevisions maps every changed object ID to its revision.'],
    'document.fragment.import': ['Copy fragment from canvas_observe with fragment={kind:"illustration-objects",objectIds:[...]} or fragment={kind:"pixel-assets",assetId:...}. Supply that returned fragment intact; it is validated again and does not grant file authority.'],
  };
  if (kind.startsWith('illustration.path.node.') || kind === 'illustration.path.split') common.push('Use canvas_observe with pathObjectId to obtain current node/segment indices. Node coordinates are object-local pixels; insertion time is a fraction strictly between 0 and 1 along the addressed segment. A split or node edit must retain valid single-subpath geometry.');
  if (kind.startsWith('pixel.')) common.push('Pixel indices refer to the observed palette; sprite coordinates are pixels and tilemap coordinates are cells. Derive GIDs from observed attached tilesets, preserving transform bits; do not invent tile or palette references. Revisions belong to the exact entities named by each field.');
  if (kind.startsWith('pixel.image-collection.') || kind === 'pixel.tile-object.create') common.push('This topology operation must be the sole operation in its request. Use the observed document revision plus the named source/tileset/map revisions; existing reference-resolution and ownership proofs may refuse the change.');
  if (kind.startsWith('illustration.objects.')) common.push('objectIds selects existing compatible objects; expectedRevisions maps every selected object ID to its observed revision. Alignment modes use world-space bounds; key-object target requires keyObjectId from the selection. Distribution requires at least three objects.');
  return [...common, ...(rules[kind] ?? [])];
}
