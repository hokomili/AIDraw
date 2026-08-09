import { createHash } from 'node:crypto';
import type { ImportUtilityRequest } from './utility-contract';

export async function runImportUtilityRequest(request: ImportUtilityRequest) {
  const importer = await import('./import-document');
  if (!request.spriteSheet) return importer.importDocument(request.filePath, request.pixelMode);
  const bytes = await importer.readBoundedImportFile(request.filePath);
  if (createHash('sha256').update(bytes).digest('hex') !== request.spriteSheet.expectedSha256) {
    throw new Error('The selected sprite-sheet file changed before the utility process read it.');
  }
  return importer.importSlicedSpriteSheetBytes(bytes, request.spriteSheet.name, request.spriteSheet.mimeType, request.spriteSheet.options);
}
