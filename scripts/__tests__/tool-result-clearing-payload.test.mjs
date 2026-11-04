import { expect, it } from 'vitest';
import { qualify, qualifyAll, comparePayloads, diffPaths } from '../../packages/turn/scripts/tool-result-clearing-qualify.mjs';
import { qualificationIdentity } from '../lib/tool-result-clearing-qualification-id.mjs';
import { APIS, mapReference } from '../lib/tool-result-clearing-reference.mjs';

it.each(APIS)('qualifies only targeted earlier result text through the real %s builder', async api => {
  const report = await qualify(api, f => {
    expect(f.networkAttempts).toBe(0);
    expect(diffPaths(f.messages, f.mapped)).toEqual(['2.content.0.text', '4.content.0.text']);
    for (let i = 5; i < f.messages.length; i++) expect(f.mapped[i]).toBe(f.messages[i]);
    expect(comparePayloads(f.before, f.after, api, f.messages, f.selections)).toBe(true);
    const serializedBefore = JSON.stringify(f.before), serializedAfter = JSON.stringify(f.after);
    if (api === 'anthropic-messages') {
      expect(serializedBefore).toContain(f.thinkingSignature);
      expect(serializedAfter).toContain(f.thinkingSignature);
      expect(serializedAfter).toContain('Fictional signed thought.');
      expect(serializedAfter).toContain('fictional-opaque-signed');
    } else if (api.includes('responses')) {
      expect(f.before.input.find(x => x.type === 'reasoning')).toEqual(f.reasoning);
      expect(f.after.input.find(x => x.type === 'reasoning')).toEqual(f.reasoning);
    }
    // Mutation controls prove the allowlist rejects non-text changes anywhere.
    for (const mutate of [
      p => { p.model = 'unintended'; },
      p => { if (p.input) p.input.reverse(); else p.messages.reverse(); },
      p => { if (p.input) p.input.find(x => x.type === 'function_call').call_id = 'unintended';
        else p.messages.find(x => x.role === 'assistant').content = 'unintended'; },
    ]) {
      const invalid = structuredClone(f.after); mutate(invalid);
      expect(comparePayloads(f.before, invalid, api, f.messages, f.selections)).toBe(false);
    }
    for (const i of [6, 8, 10, 12]) {
      expect(() => mapReference(f.messages, new Map([[i, [...f.selections.values()][0]]]))).toThrow('INELIGIBLE_SELECTION');
    }
    expect(JSON.stringify(f.messages)).not.toContain('cleared from working context');
  });
  expect(report).toMatchObject({ api, status: 'payload-preserving', unintendedDifferences: 0, targetedTextChanges: 2 });
  if (api === 'openai-codex-responses') expect(report).toMatchObject({ wire: 'wire-unproven (transport)', verdict: 'DEFER' });
});

it('binds qualification to installed pi-ai and the exact fixture/reference sources', async () => {
  expect(await qualifyAll()).toMatchObject(qualificationIdentity());
});
