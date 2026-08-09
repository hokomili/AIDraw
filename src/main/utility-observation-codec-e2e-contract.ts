import { crc32 } from 'node:zlib';
import type { ObservationRequest } from './capture-observation';

export const FND09_OBSERVATION_CODEC_E2E_REQUEST = {
  scale: 1,
  background: 'transparent',
  region: { x: 0, y: 0, width: 8, height: 6 },
} satisfies ObservationRequest;
export const FND09_OBSERVATION_CODEC_E2E_MAX_PIXELS = 48;
export const FND09_OBSERVATION_CODEC_E2E_HOLD_MS = 150;

export function isFnd09ObservationCodecE2eEnabled(input: { nodeEnv?: string; enabled?: string }): boolean {
  return input.nodeEnv === 'test' && input.enabled === '1';
}

/**
 * Fixed packaged-QA mutation: preserve the PNG envelope and IDAT CRC while
 * making the compressed stream undecodable. The result must still cross the
 * production main-owned decoder boundary and fail there.
 */
export function corruptFnd09ObservationIdat(dataBase64: string): string {
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.toString('base64') !== dataBase64) throw new Error('The observation codec fixture requires canonical base64.');
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = bytes.readUInt32BE(offset);
    if (chunkLength > bytes.byteLength - offset - 12) throw new Error('The observation codec fixture received a malformed PNG.');
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (bytes.toString('ascii', typeStart, dataStart) === 'IDAT' && chunkLength > 0) {
      bytes[dataStart] ^= 0xff;
      bytes.writeUInt32BE(crc32(bytes.subarray(typeStart, dataEnd)) >>> 0, dataEnd);
      return bytes.toString('base64');
    }
    offset = dataEnd + 4;
  }
  throw new Error('The observation codec fixture requires one nonempty IDAT chunk.');
}
