import type { AIDrawDocument, Id } from './model';

/**
 * Returns stable, human-readable locations that currently depend on an embedded
 * document asset. Callers can use these paths in conflict messages or a future
 * explicit cascade preview.
 */
export function findDocumentAssetReferences(document: AIDrawDocument, assetId: Id): string[] {
  const references: string[] = [];

  if (document.kind === 'illustration') {
    for (const object of Object.values(document.objects)) {
      if (object.type === 'image' && object.assetId === assetId) references.push(`objects.${object.id}.assetId`);
    }
    for (const layer of Object.values(document.layers)) {
      if (layer.type !== 'paint') continue;
      for (const [tile, referencedId] of Object.entries(layer.tileAssetIds)) {
        if (referencedId === assetId) references.push(`layers.${layer.id}.tileAssetIds.${tile}`);
      }
    }
  } else {
    for (const link of document.linkedAssets) {
      if (link.cachedPreviewAssetId === assetId) references.push(`linkedAssets.${link.id}.cachedPreviewAssetId`);
    }
  }

  for (const entry of document.provenance) {
    if (entry.assetId === assetId) references.push(`provenance.${entry.id}.assetId`);
    if (entry.maskAssetId === assetId) references.push(`provenance.${entry.id}.maskAssetId`);
    entry.sourceAssetIds.forEach((sourceAssetId, index) => {
      if (sourceAssetId === assetId) references.push(`provenance.${entry.id}.sourceAssetIds.${index}`);
    });
  }

  return references;
}
