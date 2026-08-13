/**
 * One binary entry inside a native .aidraw ZIP. Image validation reuses this
 * existing storage ceiling instead of inventing a second native payload limit.
 */
export const MAX_NATIVE_BINARY_ENTRY_BYTES = 128 * 1024 * 1024;
