/**
 * Main-owned resource ceilings for data returned across the utility-process
 * boundary. These limits complement format-specific image/document checks;
 * they do not make the child process authoritative for its own output size.
 */
export const MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES = 512 * 1024 * 1024;
export const MAX_EXPORT_UTILITY_MEMBERS = 4_097;
export const MAX_IMPORT_UTILITY_SERIALIZED_BYTES = 512 * 1024 * 1024;
export const MAX_IMPORT_UTILITY_NODES = 16_777_216;
export const MAX_IMPORT_UTILITY_DEPTH = 128;
export const MAX_UTILITY_REPORT_ENTRIES = 4_096;
export const MAX_UTILITY_REPORT_SERIALIZED_BYTES = 1024 * 1024;
export const MAX_UTILITY_TEXT_BYTES = 64 * 1024;
export const MAX_UTILITY_ERROR_CODE_BYTES = 256;
export const MAX_UTILITY_ERROR_MESSAGE_BYTES = 16 * 1024;

export interface UtilityJsonBudget {
  label: string;
  maxBytes: number;
  maxNodes: number;
  maxDepth: number;
}

function assertPositiveBudget(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
}

function jsonStringSerializedByteLengthUpTo(value: string, limit: number): number {
  if (value.length + 2 > limit) return limit + 1;
  let result = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) result += 2;
    else if (code <= 0x1f) result += 6;
    else if (code <= 0x7f) result += 1;
    else if (code <= 0x7ff) result += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { result += 4; index += 1; }
    else if (code >= 0xd800 && code <= 0xdfff) result += 6;
    else result += 3;
    if (result > limit) return limit + 1;
  }
  return result;
}

/** Exact UTF-8 byte count of JSON.stringify(value) for one string, without allocating its escaped copy. */
export function jsonStringSerializedByteLength(value: string): number {
  return jsonStringSerializedByteLengthUpTo(value, Number.MAX_SAFE_INTEGER - 1);
}

export function isBoundedUtilityString(value: unknown, maxBytes: number, allowEmpty = true): value is string {
  if (typeof value !== 'string' || !allowEmpty && value.length === 0 || value.length > maxBytes) return false;
  return Buffer.byteLength(value, 'utf8') <= maxBytes;
}

/**
 * Measure the exact JSON UTF-8 representation using bounded recursion and no
 * whole-value serialization. Undefined object properties follow JSON omission;
 * undefined array entries become null. Cycles and non-JSON object types fail.
 */
export function assertUtilityJsonBudget(value: unknown, budget: UtilityJsonBudget): number {
  assertPositiveBudget(budget.maxBytes, 'JSON byte budget');
  assertPositiveBudget(budget.maxNodes, 'JSON node budget');
  assertPositiveBudget(budget.maxDepth, 'JSON depth budget');
  let bytes = 0;
  let nodes = 0;
  const active = new Set<object>();

  const addBytes = (amount: number) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > budget.maxBytes - bytes) {
      throw new Error(`${budget.label} exceeds its ${budget.maxBytes}-byte serialized limit.`);
    }
    bytes += amount;
  };
  const addString = (text: string) => {
    const length = jsonStringSerializedByteLengthUpTo(text, budget.maxBytes - bytes);
    addBytes(length);
  };
  const addNode = () => {
    nodes += 1;
    if (nodes > budget.maxNodes) throw new Error(`${budget.label} exceeds its ${budget.maxNodes}-node structural limit.`);
  };

  const visit = (candidate: unknown, depth: number, arrayElement = false): void => {
    addNode();
    if (depth > budget.maxDepth) throw new Error(`${budget.label} exceeds its ${budget.maxDepth}-level depth limit.`);
    if (candidate === null) { addBytes(4); return; }
    if (candidate === undefined) {
      if (arrayElement) { addBytes(4); return; }
      throw new Error(`${budget.label} is not bounded JSON data.`);
    }
    if (typeof candidate === 'string') { addString(candidate); return; }
    if (typeof candidate === 'boolean') { addBytes(candidate ? 4 : 5); return; }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error(`${budget.label} is not bounded JSON data.`);
      addBytes(String(Object.is(candidate, -0) ? 0 : candidate).length);
      return;
    }
    if (typeof candidate !== 'object') throw new Error(`${budget.label} is not bounded JSON data.`);
    const prototype = Object.getPrototypeOf(candidate);
    if (Array.isArray(candidate) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error(`${budget.label} is not bounded JSON data.`);
    if (active.has(candidate)) throw new Error(`${budget.label} is cyclic and cannot be serialized.`);
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > budget.maxNodes - nodes) throw new Error(`${budget.label} exceeds its ${budget.maxNodes}-node structural limit.`);
        addBytes(2 + Math.max(0, candidate.length - 1));
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor) visit(undefined, depth + 1, true);
          else if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error(`${budget.label} is not bounded JSON data.`);
          else visit(descriptor.value, depth + 1, true);
        }
        return;
      }

      const keys = Object.keys(candidate);
      addBytes(2);
      let retained = 0;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error(`${budget.label} is not bounded JSON data.`);
        if (descriptor.value === undefined) continue;
        if (retained > 0) addBytes(1);
        addString(key); addBytes(1);
        visit(descriptor.value, depth + 1);
        retained += 1;
      }
    } finally {
      active.delete(candidate);
    }
  };

  visit(value, 0);
  return bytes;
}

/** Numeric aggregate check lets large production ceilings be tested without allocating ceiling-sized fixtures. */
export function assertUtilityAggregateByteLimit(lengths: readonly number[], maxBytes: number, label: string): number {
  assertPositiveBudget(maxBytes, 'Aggregate byte budget');
  let total = 0;
  for (const length of lengths) {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`${label} contains an invalid byte length.`);
    if (length > maxBytes - total) throw new Error(`${label} exceeds its ${maxBytes}-byte aggregate limit.`);
    total += length;
  }
  return total;
}

export function boundedUtilityErrorMessage(error: unknown): string {
  const source = error instanceof Error && typeof error.message === 'string'
    ? error.message
    : 'Utility task failed with a non-Error value.';
  let measuredBytes = 0;
  let measuredPrefix = '';
  let exceeded = false;
  for (const character of source) {
    const next = Buffer.byteLength(character, 'utf8');
    if (measuredBytes + next > MAX_UTILITY_ERROR_MESSAGE_BYTES) { exceeded = true; break; }
    measuredPrefix += character; measuredBytes += next;
  }
  if (!exceeded) return source;
  const suffix = '… [truncated]';
  const targetBytes = MAX_UTILITY_ERROR_MESSAGE_BYTES - Buffer.byteLength(suffix, 'utf8');
  let result = '';
  let bytes = 0;
  for (const character of measuredPrefix) {
    const next = Buffer.byteLength(character, 'utf8');
    if (bytes + next > targetBytes) break;
    result += character; bytes += next;
  }
  return result + suffix;
}
