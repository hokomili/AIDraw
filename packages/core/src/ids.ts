import type { Id } from './model';

export function createId(prefix = 'id'): Id {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${value}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
