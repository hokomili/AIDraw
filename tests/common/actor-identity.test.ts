import { describe, expect, it } from 'vitest';
import { actorClientLabel, actorIdentityLabel } from '../../src/common/actor-identity';

describe('actor identity labels', () => {
  it('never renders missing model or effort as undefined', () => {
    const actor = { id: 'agent-1', kind: 'agent' as const, name: 'Luna', color: '#8268dd' };
    expect(actorClientLabel(actor)).toBeUndefined();
    expect(actorIdentityLabel(actor)).toBe('Luna');
    expect(actorIdentityLabel({ ...actor, client: { model: 'luna', reasoningEffort: 'high' as const } })).toBe('Luna · luna · high');
  });
});
