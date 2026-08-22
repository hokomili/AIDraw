import { randomBytes, randomUUID } from 'node:crypto';

export const MCP_AUTHORITY_BYTES = 32;
export const MCP_AUTHORITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MCP_BRIDGE_PROVISIONAL_HEADER = 'x-aidraw-bridge-provisional-id';
export const MCP_BRIDGE_PROVISIONAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Mint one engine-lifetime MCP capability. It may appear only in the live
 * engine's product-owned private run state so the no-secret stdio bridge can
 * resolve it; it is never a durable client setting and becomes invalid when
 * the owning engine stops.
 */
export function createEphemeralMcpAuthority(random: (size: number) => Buffer = randomBytes): string {
  const authority = random(MCP_AUTHORITY_BYTES).toString('base64url');
  if (!MCP_AUTHORITY_PATTERN.test(authority)
    || Buffer.from(authority, 'base64url').byteLength !== MCP_AUTHORITY_BYTES
    || Buffer.from(authority, 'base64url').toString('base64url') !== authority) {
    throw new Error('MCP authority creation returned an invalid value.');
  }
  return authority;
}

/**
 * Correlate an in-flight bridge initialize with server-side retirement when
 * the response is lost before the bridge can learn the resulting session ID.
 * This value is not authority and never leaves the authenticated loopback
 * exchange.
 */
export function createMcpBridgeProvisionalId(random: () => string = randomUUID): string {
  const provisionalId = random();
  if (!MCP_BRIDGE_PROVISIONAL_ID_PATTERN.test(provisionalId)) {
    throw new Error('MCP bridge provisional identity creation returned an invalid value.');
  }
  return provisionalId;
}
