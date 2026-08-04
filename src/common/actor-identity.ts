import type { Actor } from '@aidraw/core';

export function actorClientLabel(actor: Actor): string | undefined {
  const details = [actor.client?.model, actor.client?.reasoningEffort].filter((value): value is string => Boolean(value));
  return details.length ? details.join(' · ') : undefined;
}

export function actorIdentityLabel(actor: Actor): string {
  const client = actorClientLabel(actor);
  return client ? `${actor.name} · ${client}` : actor.name;
}
