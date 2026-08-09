import type { GeneratedOutput, GenerationRequest } from '../common/generation';

export type Fnd09GenerationResultFault =
  | 'result-count'
  | 'mime-header'
  | 'dimension-header'
  | 'seed'
  | 'metadata';

export type Fnd09GenerationResultFixture = 'valid' | Fnd09GenerationResultFault;

export const FND09_GENERATION_RESULT_E2E_HOLD_MS = 150;
export const FND09_GENERATION_RESULT_E2E_PROMPT = 'FND-09 deterministic local generation result fixture';
export const FND09_GENERATION_RESULT_E2E_SEED = 24_681_357;
/** Locally embedded 1x1 RGBA PNG; no provider or network request is involved. */
export const FND09_GENERATION_RESULT_E2E_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZYxAUFPwPAAGdATO384aOAAAAAElFTkSuQmCC';

export function isFnd09GenerationResultE2eEnabled(input: { nodeEnv?: string; enabled?: string }): boolean {
  return input.nodeEnv === 'test' && input.enabled === '1';
}

export function isFnd09GenerationResultFixture(value: unknown): value is Fnd09GenerationResultFixture {
  return value === 'valid'
    || value === 'result-count'
    || value === 'mime-header'
    || value === 'dimension-header'
    || value === 'seed'
    || value === 'metadata';
}

export function isFnd09GenerationResultRequest(request: GenerationRequest): boolean {
  return request.provider === 'stability'
    && request.mode === 'create'
    && request.prompt === FND09_GENERATION_RESULT_E2E_PROMPT
    && request.negativePrompt === undefined
    && request.sourceAssetIds.length === 0
    && request.maskAssetId === undefined
    && request.size !== 'auto'
    && request.size.width === 1
    && request.size.height === 1
    && request.resultCount === 1
    && request.seed === FND09_GENERATION_RESULT_E2E_SEED
    && Object.keys(request.providerOptions).length === 0;
}

function validOutput(): GeneratedOutput {
  return {
    id: 'fnd09-generation-result-0',
    mimeType: 'image/png',
    data: FND09_GENERATION_RESULT_E2E_PNG_BASE64,
    width: 1,
    height: 1,
    seed: FND09_GENERATION_RESULT_E2E_SEED,
    providerMetadata: { fixture: 'local-deterministic', resultIndex: 0 },
  };
}

/** Return a deterministic local result, then mutate only the requested response contract for packaged QA. */
export function createFnd09GenerationResultOutputs(
  request: GenerationRequest,
  fixture: Fnd09GenerationResultFixture,
): unknown[] {
  if (!isFnd09GenerationResultRequest(request)) {
    throw new Error('The generation-result probe requires the exact provider-free local request baseline.');
  }
  const output = validOutput();
  if (fixture === 'valid') return [output];
  if (fixture === 'result-count') {
    return [output, { ...output, id: 'fnd09-generation-result-1', seed: FND09_GENERATION_RESULT_E2E_SEED + 1 }];
  }
  if (fixture === 'mime-header') return [{ ...output, mimeType: 'image/jpeg' }];
  if (fixture === 'dimension-header') return [{ ...output, width: 2 }];
  if (fixture === 'seed') return [{ ...output, seed: FND09_GENERATION_RESULT_E2E_SEED + 1 }];
  return [{ ...output, providerMetadata: [] }];
}
