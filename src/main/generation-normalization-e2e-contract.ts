import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { GeneratedAcceptancePreparation, GeneratedOutput } from '../common/generation';

export const FND09_GENERATION_NORMALIZATION_E2E_PROFILE_PREFIX = 'aidraw-e2e-fnd09-generation-normalization-';
export const FND09_GENERATION_NORMALIZATION_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_FILE = 'fnd09-normalizable-provider-preview.png';
export const FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_FILE = 'fnd09-preview-only-provider-preview.png';
export const FND09_GENERATION_NORMALIZATION_E2E_AUDIT_FILE = 'fnd09-generation-normalization-fixture-audit.json';
export const FND09_GENERATION_NORMALIZATION_E2E_READY_PROBE_FILE = 'fnd09-generation-normalization-ready-probe.json';
export const FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_PROBE_FILE = 'fnd09-generation-normalization-preview-only-probe.json';
export const FND09_GENERATION_NORMALIZATION_E2E_NETWORK_SENTINEL_FILE = 'fnd09-generation-normalization-forbidden-network.json';

export interface Fnd09GenerationNormalizationE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  normalizableOutputPath: string;
  previewOnlyOutputPath: string;
  auditPath: string;
  readyProbePath: string;
  previewOnlyProbePath: string;
  networkSentinelPath: string;
}

interface ConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  workspacePath: string;
  declaredProfilePath?: string;
  userDataPath?: string;
  connectionPath?: string;
  normalizableOutputPath?: string;
  previewOnlyOutputPath?: string;
  auditPath?: string;
  readyProbePath?: string;
  previewOnlyProbePath?: string;
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

/** Resolve only one fixed, never-user-configurable packaged normalization fixture. */
export function resolveFnd09GenerationNormalizationE2eConfiguration(
  input: ConfigurationInput,
): Fnd09GenerationNormalizationE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath || !input.normalizableOutputPath
    || !input.previewOnlyOutputPath || !input.auditPath || !input.readyProbePath || !input.previewOnlyProbePath
    || !input.networkSentinelPath) return undefined;
  const retainedRoot = resolve(input.workspacePath, 'test-results', 'retained');
  const profilePath = resolve(input.userDataPath);
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (normalizedPath(dirname(profilePath)) !== normalizedPath(retainedRoot)) return undefined;
  if (!basename(profilePath).toLowerCase().startsWith(FND09_GENERATION_NORMALIZATION_E2E_PROFILE_PREFIX)) return undefined;
  const namedPaths = [
    [input.connectionPath, FND09_GENERATION_NORMALIZATION_E2E_CONNECTION_FILE],
    [input.normalizableOutputPath, FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_FILE],
    [input.previewOnlyOutputPath, FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_FILE],
    [input.auditPath, FND09_GENERATION_NORMALIZATION_E2E_AUDIT_FILE],
    [input.readyProbePath, FND09_GENERATION_NORMALIZATION_E2E_READY_PROBE_FILE],
    [input.previewOnlyProbePath, FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_PROBE_FILE],
    [input.networkSentinelPath, FND09_GENERATION_NORMALIZATION_E2E_NETWORK_SENTINEL_FILE],
  ] as const;
  if (namedPaths.some(([candidate, name]) => !isNamedDirectChild(profilePath, candidate, name))) return undefined;
  return {
    profilePath,
    connectionPath: resolve(input.connectionPath),
    normalizableOutputPath: resolve(input.normalizableOutputPath),
    previewOnlyOutputPath: resolve(input.previewOnlyOutputPath),
    auditPath: resolve(input.auditPath),
    readyProbePath: resolve(input.readyProbePath),
    previewOnlyProbePath: resolve(input.previewOnlyProbePath),
    networkSentinelPath: resolve(input.networkSentinelPath),
  };
}

export function resolveFnd09GenerationNormalizationE2eFromEnvironment(): Fnd09GenerationNormalizationE2eConfiguration | undefined {
  return resolveFnd09GenerationNormalizationE2eConfiguration({
    nodeEnv: process.env.NODE_ENV,
    enabled: process.env.AIDRAW_E2E_GENERATION_NORMALIZATION,
    workspacePath: process.cwd(),
    declaredProfilePath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_PROFILE,
    userDataPath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_PROFILE,
    connectionPath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_CONNECTION_PATH,
    normalizableOutputPath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_NORMALIZABLE_OUTPUT_PATH,
    previewOnlyOutputPath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_PREVIEW_ONLY_OUTPUT_PATH,
    auditPath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_AUDIT_PATH,
    readyProbePath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_READY_PROBE_PATH,
    previewOnlyProbePath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_PREVIEW_ONLY_PROBE_PATH,
    networkSentinelPath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_NETWORK_SENTINEL_PATH,
  });
}

/** Retain sanitized proof that normalization executed inside the utility process. */
export async function writeFnd09GenerationNormalizationE2eProbe(
  configuration: Fnd09GenerationNormalizationE2eConfiguration,
  output: GeneratedOutput,
  result: GeneratedAcceptancePreparation,
): Promise<void> {
  const sourceBytes = Buffer.from(output.data, 'base64');
  const source = {
    outputId: output.id,
    mimeType: output.mimeType,
    byteLength: sourceBytes.byteLength,
    sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    width: output.width,
    height: output.height,
  };
  const probe = result.status === 'ready'
    ? {
        version: 1,
        scenario: 'FND-09 packaged generated-preview acceptance normalization',
        process: { role: 'electron-utility-process', pid: process.pid },
        requestKind: 'normalize-generation-acceptance',
        source,
        result: {
          status: result.status,
          mimeType: result.mimeType,
          width: result.width,
          height: result.height,
          normalization: result.normalization,
        },
      }
    : {
        version: 1,
        scenario: 'FND-09 packaged generated-preview acceptance normalization',
        process: { role: 'electron-utility-process', pid: process.pid },
        requestKind: 'normalize-generation-acceptance',
        source,
        result: { status: result.status, reason: result.reason, message: result.message, guidance: result.guidance },
      };
  await writeFile(result.status === 'ready' ? configuration.readyProbePath : configuration.previewOnlyProbePath, `${JSON.stringify(probe, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
