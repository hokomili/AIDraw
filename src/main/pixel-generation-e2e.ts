import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import type { GenerationRequest } from '../common/generation';
import type { GenerationProviderRunner } from './generation-provider-runner';

export const QA06_PIXEL_PALETTE_E2E_PROFILE_PREFIX = 'aidraw-e2e-qa06-pixel-palette-';
export const QA06_PIXEL_PALETTE_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const QA06_PIXEL_PALETTE_E2E_OUTPUT_FILE = 'qa06-pixel-palette-mock-output.png';
export const QA06_PIXEL_PALETTE_E2E_AUDIT_FILE = 'qa06-pixel-palette-mock-audit.json';
export const QA06_PIXEL_PALETTE_E2E_NETWORK_SENTINEL_FILE = 'qa06-pixel-palette-forbidden-network.json';
export const QA06_PIXEL_PALETTE_E2E_DOCUMENT_NAME = 'QA-06 Pixel Palette Conversion';
export const QA06_PIXEL_PALETTE_E2E_APPROVAL_TIMEOUT_MS = 60_000;

export const QA06_PIXEL_PALETTE_E2E_REQUEST = {
  provider: 'stability',
  mode: 'create',
  prompt: 'Convert the deterministic local color study into the active indexed sprite palette.',
  negativePrompt: 'text, watermark, gradients',
  sourceAssetIds: [],
  size: { width: 32, height: 32 },
  aspectIntent: 'square',
  resultCount: 1,
  seed: 97531,
  providerOptions: { stylePreset: 'pixel-art' },
} as const satisfies Omit<GenerationRequest, 'documentId'>;

export interface Qa06PixelPaletteE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  outputPath: string;
  auditPath: string;
  networkSentinelPath: string;
  approvalTimeoutMs: number;
}

interface Qa06PixelPaletteE2eConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  declaredProfilePath?: string;
  userDataPath?: string;
  connectionPath?: string;
  outputPath?: string;
  auditPath?: string;
  networkSentinelPath?: string;
}

function normalizedPath(value: string): string {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isNamedDirectChild(profilePath: string, candidatePath: string, expectedName: string): boolean {
  const candidate = resolve(candidatePath);
  return normalizedPath(dirname(candidate)) === normalizedPath(profilePath)
    && basename(candidate).toLowerCase() === expectedName;
}

/**
 * Enables one exact, deterministic pixel-palette generation fixture. The
 * boundary accepts only a named isolated profile and fixed direct-child
 * artifacts, so it cannot become a general provider or file-writing hook.
 */
export function resolveQa06PixelPaletteE2eConfiguration(
  input: Qa06PixelPaletteE2eConfigurationInput,
): Qa06PixelPaletteE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath || !input.outputPath || !input.auditPath || !input.networkSentinelPath) return undefined;
  const profilePath = resolve(input.userDataPath);
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (!basename(profilePath).toLowerCase().startsWith(QA06_PIXEL_PALETTE_E2E_PROFILE_PREFIX)) return undefined;
  if (!isNamedDirectChild(profilePath, input.connectionPath, QA06_PIXEL_PALETTE_E2E_CONNECTION_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.outputPath, QA06_PIXEL_PALETTE_E2E_OUTPUT_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.auditPath, QA06_PIXEL_PALETTE_E2E_AUDIT_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.networkSentinelPath, QA06_PIXEL_PALETTE_E2E_NETWORK_SENTINEL_FILE)) return undefined;
  return {
    profilePath,
    connectionPath: resolve(input.connectionPath),
    outputPath: resolve(input.outputPath),
    auditPath: resolve(input.auditPath),
    networkSentinelPath: resolve(input.networkSentinelPath),
    approvalTimeoutMs: QA06_PIXEL_PALETTE_E2E_APPROVAL_TIMEOUT_MS,
  };
}

/** Blocks unexpected non-loopback Node fetches while the isolated fixture is active. */
export function installQa06PixelPaletteE2eNetworkBoundary(configuration: Qa06PixelPaletteE2eConfiguration): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return originalFetch(input, init);
    const sentinel = { version: 1, blocked: true, protocol: url.protocol, hostname: url.hostname, externalProviderRequests: 1, paidRequests: 0 };
    await writeFile(configuration.networkSentinelPath, `${JSON.stringify(sentinel, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(() => undefined);
    throw new Error('The isolated QA-06 pixel-palette fixture blocked an external provider request.');
  };
  return () => { globalThis.fetch = originalFetch; };
}

export function qa06PixelPaletteExpectedIndex(x: number, y: number): number {
  if (x === 0 || y === 0 || x === 15 || y === 15) return 1;
  if (y < 8) return x < 8 ? 4 : 9;
  if (x < 8) return 7;
  return (x + y) % 2 === 0 ? 15 : 0;
}

function deterministicOutput(): Buffer {
  const canvas = createCanvas(QA06_PIXEL_PALETTE_E2E_REQUEST.size.width, QA06_PIXEL_PALETTE_E2E_REQUEST.size.height);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  const colors: Record<number, string> = {
    1: '#27213c',
    4: '#ff6b7a',
    7: '#9be3c2',
    9: '#3978b8',
    15: '#e5b84b',
  };
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) {
    const index = qa06PixelPaletteExpectedIndex(x, y);
    if (index === 0) continue;
    context.fillStyle = colors[index];
    context.fillRect(x * 2, y * 2, 2, 2);
  }
  return canvas.toBuffer('image/png');
}

function assertFixtureRequest(input: Parameters<GenerationProviderRunner>[0]): void {
  const { document, request, credential } = input;
  if (credential !== undefined) throw new Error('The isolated QA-06 pixel-palette runner refuses hosted provider keys.');
  const active = document.kind === 'pixel' ? document.pixelAssets[document.activeAssetId] : undefined;
  if (document.kind !== 'pixel' || document.standaloneType !== 'sprite' || document.name !== QA06_PIXEL_PALETTE_E2E_DOCUMENT_NAME || request.documentId !== document.id) {
    throw new Error('The isolated QA-06 pixel-palette runner received an unexpected document.');
  }
  if (active?.type !== 'sprite' || active.width !== 16 || active.height !== 16 || active.frameIds.length !== 1) {
    throw new Error('The isolated QA-06 pixel-palette runner requires one 16×16 sprite frame.');
  }
  const expected = { documentId: document.id, ...QA06_PIXEL_PALETTE_E2E_REQUEST };
  if (JSON.stringify(request) !== JSON.stringify(expected)) throw new Error('The isolated QA-06 pixel-palette runner received an unexpected request payload.');
}

export function createQa06PixelPaletteE2eRunner(configuration: Qa06PixelPaletteE2eConfiguration): GenerationProviderRunner {
  return async (input, control) => {
    assertFixtureRequest(input);
    if (control.signal.aborted) throw control.signal.reason ?? new DOMException('Aborted', 'AbortError');
    control.onProgress?.(0.3, 'Preparing deterministic local palette study…');
    const bytes = deterministicOutput();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(configuration.outputPath, bytes, { flag: 'wx', mode: 0o600 });
    if (control.signal.aborted) throw control.signal.reason ?? new DOMException('Aborted', 'AbortError');
    control.onProgress?.(0.85, 'Finalizing deterministic local palette study…');
    const audit = {
      version: 1,
      fixture: 'qa06-pixel-palette-conversion',
      transport: 'in-process-deterministic-runner',
      invocationCount: 1,
      requestSha256: createHash('sha256').update(JSON.stringify(input.request)).digest('hex'),
      output: { file: QA06_PIXEL_PALETTE_E2E_OUTPUT_FILE, byteLength: bytes.byteLength, sha256, width: 32, height: 32 },
      hostedKeyReceived: false,
      externalProviderRequests: 0,
      paidRequests: 0,
    };
    await writeFile(configuration.auditPath, `${JSON.stringify(audit, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return [{
      id: 'qa06-pixel-palette-result',
      mimeType: 'image/png',
      data: bytes.toString('base64'),
      width: 32,
      height: 32,
      seed: QA06_PIXEL_PALETTE_E2E_REQUEST.seed,
      providerMetadata: { fixture: 'qa06-pixel-palette-conversion', transport: 'deterministic-local', externalProviderRequests: 0, paidRequests: 0 },
    }];
  };
}
