import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import type { GenerationRequest } from '../common/generation';
import type { GenerationProviderRunner } from './generation-provider-runner';

export const QA06_GENERATION_E2E_PROFILE_PREFIX = 'aidraw-e2e-qa06-generated-fill-';
export const QA06_GENERATION_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const QA06_GENERATION_E2E_OUTPUT_FILE = 'qa06-generated-fill-mock-output.png';
export const QA06_GENERATION_E2E_AUDIT_FILE = 'qa06-generated-fill-mock-audit.json';
export const QA06_GENERATION_E2E_NETWORK_SENTINEL_FILE = 'qa06-forbidden-external-provider-request.json';
export const QA06_GENERATION_E2E_DOCUMENT_NAME = 'QA-06 Generated Fill';
export const QA06_GENERATION_E2E_SOURCE_ASSET_ID = 'qa06-generation-source';
export const QA06_GENERATION_E2E_MASK_ASSET_ID = 'qa06-generation-mask';
export const QA06_GENERATION_E2E_APPROVAL_TIMEOUT_MS = 20_000;

export const QA06_GENERATION_E2E_REQUEST = {
  provider: 'stability',
  mode: 'inpaint',
  prompt: 'Restore the bounded coral glow with a deterministic generated fill.',
  negativePrompt: 'text, watermark, border',
  sourceAssetIds: [QA06_GENERATION_E2E_SOURCE_ASSET_ID],
  maskAssetId: QA06_GENERATION_E2E_MASK_ASSET_ID,
  size: { width: 192, height: 128 },
  aspectIntent: 'landscape',
  resultCount: 1,
  seed: 24681357,
  providerOptions: { stylePreset: 'digital-art' },
} as const satisfies Omit<GenerationRequest, 'documentId'>;

export interface Qa06GenerationE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  outputPath: string;
  auditPath: string;
  networkSentinelPath: string;
  approvalTimeoutMs: number;
}

interface Qa06GenerationE2eConfigurationInput {
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
 * Enables the deterministic generation runner only for one explicit, isolated
 * QA-06 profile and fixed direct-child artifacts. It cannot be repurposed as a
 * production provider, arbitrary file writer, or credential-bearing adapter.
 */
export function resolveQa06GenerationE2eConfiguration(
  input: Qa06GenerationE2eConfigurationInput,
): Qa06GenerationE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath || !input.outputPath || !input.auditPath || !input.networkSentinelPath) return undefined;
  const profilePath = resolve(input.userDataPath);
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (!basename(profilePath).toLowerCase().startsWith(QA06_GENERATION_E2E_PROFILE_PREFIX)) return undefined;
  if (!isNamedDirectChild(profilePath, input.connectionPath, QA06_GENERATION_E2E_CONNECTION_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.outputPath, QA06_GENERATION_E2E_OUTPUT_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.auditPath, QA06_GENERATION_E2E_AUDIT_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.networkSentinelPath, QA06_GENERATION_E2E_NETWORK_SENTINEL_FILE)) return undefined;
  return {
    profilePath,
    connectionPath: resolve(input.connectionPath),
    outputPath: resolve(input.outputPath),
    auditPath: resolve(input.auditPath),
    networkSentinelPath: resolve(input.networkSentinelPath),
    approvalTimeoutMs: QA06_GENERATION_E2E_APPROVAL_TIMEOUT_MS,
  };
}

/** Blocks any unexpected non-loopback Node fetch while the packaged fixture is active. */
export function installQa06GenerationE2eNetworkBoundary(configuration: Qa06GenerationE2eConfiguration): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return originalFetch(input, init);
    const sentinel = { version: 1, blocked: true, protocol: url.protocol, hostname: url.hostname, externalProviderRequests: 1, paidRequests: 0 };
    await writeFile(configuration.networkSentinelPath, `${JSON.stringify(sentinel, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(() => undefined);
    throw new Error('The isolated QA-06 fixture blocked an external provider request.');
  };
  return () => { globalThis.fetch = originalFetch; };
}

function deterministicOutput(): Buffer {
  const canvas = createCanvas(QA06_GENERATION_E2E_REQUEST.size.width, QA06_GENERATION_E2E_REQUEST.size.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#26324a';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#e8778f';
  context.fillRect(20, 20, 152, 88);
  context.fillStyle = '#ffd28a';
  context.fillRect(40, 36, 112, 56);
  context.fillStyle = '#5fc6b8';
  context.fillRect(72, 48, 48, 32);
  context.fillStyle = '#ffffff';
  context.fillRect(88, 56, 16, 16);
  return canvas.toBuffer('image/png');
}

function assertFixtureRequest(input: Parameters<GenerationProviderRunner>[0]): void {
  const { document, request, credential } = input;
  if (credential !== undefined) throw new Error('The isolated QA-06 runner refuses hosted provider keys.');
  if (document.kind !== 'illustration' || document.name !== QA06_GENERATION_E2E_DOCUMENT_NAME || request.documentId !== document.id) {
    throw new Error('The isolated QA-06 runner received an unexpected document.');
  }
  const expected = { documentId: document.id, ...QA06_GENERATION_E2E_REQUEST };
  if (JSON.stringify(request) !== JSON.stringify(expected)) throw new Error('The isolated QA-06 runner received an unexpected request payload.');
  for (const assetId of [QA06_GENERATION_E2E_SOURCE_ASSET_ID, QA06_GENERATION_E2E_MASK_ASSET_ID]) {
    const asset = document.assets[assetId];
    if (!asset?.data || asset.mimeType !== 'image/png') throw new Error(`The isolated QA-06 runner requires embedded PNG asset ${assetId}.`);
    const bytes = Buffer.from(asset.data, 'base64');
    if (asset.byteLength !== bytes.byteLength || asset.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
      throw new Error(`The isolated QA-06 runner rejected inconsistent asset ${assetId}.`);
    }
  }
}

export function createQa06GenerationE2eRunner(configuration: Qa06GenerationE2eConfiguration): GenerationProviderRunner {
  return async (input, control) => {
    assertFixtureRequest(input);
    if (control.signal.aborted) throw control.signal.reason ?? new DOMException('Aborted', 'AbortError');
    control.onProgress?.(0.3, 'Preparing deterministic local fill…');
    const bytes = deterministicOutput();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(configuration.outputPath, bytes, { flag: 'wx', mode: 0o600 });
    if (control.signal.aborted) throw control.signal.reason ?? new DOMException('Aborted', 'AbortError');
    control.onProgress?.(0.85, 'Finalizing deterministic local fill…');
    const source = input.document.assets[QA06_GENERATION_E2E_SOURCE_ASSET_ID];
    const mask = input.document.assets[QA06_GENERATION_E2E_MASK_ASSET_ID];
    const audit = {
      version: 1,
      fixture: 'qa06-generated-fill',
      transport: 'in-process-deterministic-runner',
      invocationCount: 1,
      requestSha256: createHash('sha256').update(JSON.stringify(input.request)).digest('hex'),
      sourceSha256: source.sha256,
      maskSha256: mask.sha256,
      output: { file: QA06_GENERATION_E2E_OUTPUT_FILE, byteLength: bytes.byteLength, sha256, width: QA06_GENERATION_E2E_REQUEST.size.width, height: QA06_GENERATION_E2E_REQUEST.size.height },
      hostedKeyReceived: false,
      externalProviderRequests: 0,
      paidRequests: 0,
    };
    await writeFile(configuration.auditPath, `${JSON.stringify(audit, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return [{
      id: 'qa06-generated-fill-result',
      mimeType: 'image/png',
      data: bytes.toString('base64'),
      width: QA06_GENERATION_E2E_REQUEST.size.width,
      height: QA06_GENERATION_E2E_REQUEST.size.height,
      seed: QA06_GENERATION_E2E_REQUEST.seed,
      providerMetadata: { fixture: 'qa06-generated-fill', transport: 'deterministic-local', externalProviderRequests: 0, paidRequests: 0 },
    }];
  };
}
