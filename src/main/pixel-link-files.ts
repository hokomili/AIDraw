import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  createId,
  findDocumentAssetReferences,
  type CanvasOperation,
  type DocumentAsset,
  type LinkedAsset,
  type PixelDocument,
} from '@aidraw/core';
import { relinkPixelLink } from '../common/pixel-links';
import { inspectImageHeader } from './transaction-policy';

export const MAX_PROJECT_LINK_BYTES = 1_500_000;

export function portableProjectAssetPath(document: PixelDocument, filePath: string): string {
  if (!document.filePath) throw new Error('Save the AIDraw project before creating an external relative link.');
  const portable = relative(dirname(document.filePath), resolve(filePath)).replaceAll('\\', '/');
  if (!portable || isAbsolute(portable) || /^(?:[A-Za-z]:|\/)/.test(portable)) throw new Error('The selected source must be on the same drive as the saved AIDraw project.');
  return portable;
}

export function verifiedPixelLinkCache(document: PixelDocument, linkId: string): { link: LinkedAsset; asset: DocumentAsset; bytes: Buffer } {
  const link = document.linkedAssets.find((entry) => entry.id === linkId);
  if (!link) throw new Error('Linked project asset not found.');
  const asset = link.cachedPreviewAssetId ? document.assets[link.cachedPreviewAssetId] : undefined;
  if (!asset?.data) throw new Error(`Linked asset “${link.name}” has no cached source.`);
  if (asset.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) throw new Error(`Linked asset “${link.name}” has a non-canonical cache payload.`);
  const bytes = Buffer.from(asset.data, 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_PROJECT_LINK_BYTES || asset.byteLength !== bytes.byteLength || asset.sha256.toLowerCase() !== digest || link.sha256?.toLowerCase() !== digest) {
    throw new Error(`Linked asset “${link.name}” has stale or corrupt cached content.`);
  }
  const header = inspectImageHeader(bytes);
  if (header.mimeType !== asset.mimeType || header.width < 1 || header.height < 1 || header.width > 8_192 || header.height > 8_192 || header.width * header.height > 16_777_216) throw new Error(`Linked asset “${link.name}” has inconsistent cached image metadata.`);
  return { link, asset, bytes };
}

export function projectLinkFileExtension(asset: DocumentAsset): string {
  if (asset.mimeType === 'image/png') return 'png';
  if (asset.mimeType === 'image/jpeg') return 'jpg';
  if (asset.mimeType === 'image/webp') return 'webp';
  if (asset.mimeType === 'image/gif') return 'gif';
  if (asset.mimeType === 'image/apng') return 'apng';
  throw new Error(`Project-link extraction does not support ${asset.mimeType}.`);
}

export function preparePixelLinkRelink(document: PixelDocument, linkId: string, filePath: string, bytes: Buffer): {
  linkedAssets: LinkedAsset[];
  operations: CanvasOperation[];
  relativePath: string;
  replacement: DocumentAsset;
} {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_PROJECT_LINK_BYTES) throw new Error('Relinked source images must be non-empty files no larger than 1.5 MB.');
  const header = inspectImageHeader(bytes);
  if (header.width < 1 || header.height < 1 || header.width > 8_192 || header.height > 8_192 || header.width * header.height > 16_777_216) throw new Error('Relinked source images must be at most 8192px per side and 16 megapixels.');
  const relativePath = portableProjectAssetPath(document, filePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const replacement: DocumentAsset = {
    id: createId('asset'), name: basename(filePath), mimeType: header.mimeType, byteLength: bytes.byteLength,
    sha256, source: 'embedded', data: bytes.toString('base64'),
  };
  const withReplacement = structuredClone(document); withReplacement.assets[replacement.id] = replacement;
  const linkedAssets = relinkPixelLink(withReplacement, linkId, replacement.id, sha256, relativePath);
  const operations: CanvasOperation[] = [
    { kind: 'asset.add', asset: replacement },
    { kind: 'pixel.links.replace', linkedAssets, expectedRevision: document.revision },
  ];
  const current = document.linkedAssets.find((entry) => entry.id === linkId);
  const oldCacheId = current?.cachedPreviewAssetId;
  if (oldCacheId && oldCacheId !== replacement.id) {
    const references = findDocumentAssetReferences(document, oldCacheId);
    if (references.length === 1 && references[0] === `linkedAssets.${linkId}.cachedPreviewAssetId`) operations.push({ kind: 'asset.delete', assetId: oldCacheId });
  }
  return { linkedAssets, operations, relativePath, replacement };
}
