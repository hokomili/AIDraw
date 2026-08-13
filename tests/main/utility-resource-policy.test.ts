import { describe, expect, it } from 'vitest';
import {
  MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES,
  MAX_UTILITY_ERROR_MESSAGE_BYTES,
  assertUtilityAggregateByteLimit,
  assertUtilityJsonBudget,
  boundedUtilityErrorMessage,
  isBoundedUtilityString,
  jsonStringSerializedByteLength,
} from '@main/utility-resource-policy';

const broadBudget = (label = 'Fixture') => ({ label, maxBytes: 1024 * 1024, maxNodes: 10_000, maxDepth: 32 });

describe('utility-process result resource policy', () => {
  it('measures exact JSON UTF-8 bytes without allocating a whole serialized result', () => {
    const shared = { quote: '"\\\n', unicode: '工具😀', loneSurrogate: '\ud800' };
    const sparse = [1, undefined, undefined, shared]; delete sparse[1];
    const fixture = { nullValue: null, trueValue: true, falseValue: false, number: -0, omitted: undefined, sparse, first: shared, second: shared };
    const expected = JSON.stringify(fixture);
    expect(expected).toBeDefined();
    expect(assertUtilityJsonBudget(fixture, broadBudget())).toBe(Buffer.byteLength(expected!, 'utf8'));
    expect(jsonStringSerializedByteLength(shared.quote)).toBe(Buffer.byteLength(JSON.stringify(shared.quote), 'utf8'));
    expect(jsonStringSerializedByteLength(shared.unicode)).toBe(Buffer.byteLength(JSON.stringify(shared.unicode), 'utf8'));
    expect(jsonStringSerializedByteLength(shared.loneSurrogate)).toBe(Buffer.byteLength(JSON.stringify(shared.loneSurrogate), 'utf8'));
  });

  it('fails closed on exact byte, node, depth, cycle, accessor, and non-JSON boundaries', () => {
    const fixture = { value: 'bounded' };
    const exactBytes = Buffer.byteLength(JSON.stringify(fixture), 'utf8');
    expect(assertUtilityJsonBudget(fixture, { ...broadBudget(), maxBytes: exactBytes })).toBe(exactBytes);
    expect(() => assertUtilityJsonBudget(fixture, { ...broadBudget(), maxBytes: exactBytes - 1 })).toThrow(`${exactBytes - 1}-byte serialized limit`);
    expect(assertUtilityJsonBudget([1, 2], { ...broadBudget(), maxNodes: 3 })).toBe(Buffer.byteLength('[1,2]'));
    expect(() => assertUtilityJsonBudget([1, 2], { ...broadBudget(), maxNodes: 2 })).toThrow('2-node structural limit');
    expect(() => assertUtilityJsonBudget({ one: { two: { three: true } } }, { ...broadBudget(), maxDepth: 2 })).toThrow('2-level depth limit');

    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => assertUtilityJsonBudget(cyclic, broadBudget())).toThrow('cyclic and cannot be serialized');
    expect(() => assertUtilityJsonBudget(new Map([['key', 'value']]), broadBudget())).toThrow('not bounded JSON data');
    let getterCalls = 0; const accessor = {};
    Object.defineProperty(accessor, 'poison', { enumerable: true, get: () => { getterCalls += 1; return 'must-not-read'; } });
    expect(() => assertUtilityJsonBudget(accessor, broadBudget())).toThrow('not bounded JSON data');
    expect(getterCalls).toBe(0);
  });

  it('checks production-sized aggregate ceilings numerically without ceiling-sized fixtures', () => {
    expect(assertUtilityAggregateByteLimit(
      [MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES - 1, 1],
      MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES,
      'Export fixture',
    )).toBe(MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES);
    expect(() => assertUtilityAggregateByteLimit(
      [MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES, 1],
      MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES,
      'Export fixture',
    )).toThrow(`${MAX_EXPORT_UTILITY_TOTAL_DECODED_BYTES}-byte aggregate limit`);
    expect(() => assertUtilityAggregateByteLimit([-1], 1, 'Export fixture')).toThrow('invalid byte length');
  });

  it('bounds UTF-8 text and truncates worker errors without splitting characters', () => {
    expect(isBoundedUtilityString('工具', 6)).toBe(true);
    expect(isBoundedUtilityString('工具', 5)).toBe(false);
    const bounded = boundedUtilityErrorMessage(new Error('😀'.repeat(MAX_UTILITY_ERROR_MESSAGE_BYTES)));
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(MAX_UTILITY_ERROR_MESSAGE_BYTES);
    expect(bounded).toMatch(/… \[truncated\]$/);
    expect(bounded).not.toContain('\ufffd');
    expect(boundedUtilityErrorMessage({ message: 'untrusted' })).toBe('Utility task failed with a non-Error value.');
  });
});
