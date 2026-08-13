import { createHash } from 'node:crypto';
import type { ImportUtilityRequest } from './utility-contract';

export async function runImportUtilityRequest(request: ImportUtilityRequest) {
  const importer = await import('./import-document');
  if (!request.spriteSheet) return importer.importDocument(request.filePath, request.pixelMode);
  const { inspectSpriteSheetSource, readBoundedSpriteSheetSource } = await import('./sprite-sheet-preview');
  const bytes = await readBoundedSpriteSheetSource(request.filePath);
  const identity = inspectSpriteSheetSource(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (request.spriteSheet.expectedSha256 !== undefined && sha256 !== request.spriteSheet.expectedSha256) {
    throw new Error('The selected sprite-sheet file changed before the utility process read it.');
  }
  if (request.spriteSheet.mimeType !== undefined && identity.mimeType !== request.spriteSheet.mimeType) {
    throw new Error('The selected sprite-sheet file type changed before the utility process read it.');
  }
  return importer.importSlicedSpriteSheetBytes(bytes, request.spriteSheet.name, identity.mimeType, request.spriteSheet.options);
}
