import type { DocumentAsset, LinkedAsset, PixelDocument } from '@aidraw/core';

export type PixelLinkHealth = 'ready' | 'missing-cache' | 'hash-mismatch' | 'missing-path';

export function pixelLinkHealth(document: PixelDocument, link: LinkedAsset): PixelLinkHealth {
  const cached = link.cachedPreviewAssetId ? document.assets[link.cachedPreviewAssetId] : undefined;
  if (!cached?.data) return 'missing-cache';
  if (!link.sha256 || cached.sha256.toLowerCase() !== link.sha256.toLowerCase()) return 'hash-mismatch';
  if (link.mode === 'linked' && !link.relativePath) return 'missing-path';
  return 'ready';
}

function replaceLink(document: PixelDocument, linkId: string, replace: (link: LinkedAsset, cached: DocumentAsset) => LinkedAsset): LinkedAsset[] {
  const current = document.linkedAssets.find((link) => link.id === linkId);
  if (!current) throw new Error('Linked project asset not found.');
  const cached = current.cachedPreviewAssetId ? document.assets[current.cachedPreviewAssetId] : undefined;
  if (!cached?.data) throw new Error(`Linked asset “${current.name}” has no cached source.`);
  if (!current.sha256 || cached.sha256.toLowerCase() !== current.sha256.toLowerCase()) throw new Error(`Linked asset “${current.name}” has stale cached content.`);
  return document.linkedAssets.map((link) => link.id === linkId ? replace(link, cached) : { ...link });
}

export function embedPixelLink(document: PixelDocument, linkId: string): LinkedAsset[] {
  return replaceLink(document, linkId, (link, cached) => ({ ...link, mode: 'embedded', relativePath: undefined, sha256: cached.sha256 }));
}

export function externalizePixelLink(document: PixelDocument, linkId: string, relativePath: string): LinkedAsset[] {
  if (!relativePath || /^(?:[A-Za-z]:|[/\\])/.test(relativePath)) throw new Error('External project assets require a relative path.');
  return replaceLink(document, linkId, (link, cached) => ({ ...link, mode: 'linked', relativePath: relativePath.replaceAll('\\', '/'), sha256: cached.sha256 }));
}

export function relinkPixelLink(document: PixelDocument, linkId: string, cachedPreviewAssetId: string, sha256: string, relativePath: string): LinkedAsset[] {
  if (!document.assets[cachedPreviewAssetId]?.data) throw new Error('Relinking requires a new cached source asset.');
  if (!/^[0-9a-f]{64}$/i.test(sha256) || document.assets[cachedPreviewAssetId].sha256.toLowerCase() !== sha256.toLowerCase()) throw new Error('Relinked source hash does not match its cache.');
  if (!relativePath || /^(?:[A-Za-z]:|[/\\])/.test(relativePath)) throw new Error('External project assets require a relative path.');
  if (!document.linkedAssets.some((link) => link.id === linkId)) throw new Error('Linked project asset not found.');
  return document.linkedAssets.map((link) => link.id === linkId ? { ...link, mode: 'linked', relativePath: relativePath.replaceAll('\\', '/'), sha256, cachedPreviewAssetId } : { ...link });
}

export function packPixelLinks(document: PixelDocument): LinkedAsset[] {
  const blocked = document.linkedAssets.filter((link) => pixelLinkHealth(document, link) !== 'ready');
  if (blocked.length) throw new Error(`${blocked.length} linked asset${blocked.length === 1 ? '' : 's'} cannot be packed because cached content is missing or does not match its hash.`);
  return document.linkedAssets.map((link) => ({ ...link, mode: 'embedded', relativePath: undefined }));
}
