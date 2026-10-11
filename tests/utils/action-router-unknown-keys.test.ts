import { z } from 'zod';
import { createActionRouter, describeIgnoredParams, ignoredParamsOf } from '../../src/utils/action-router.js';

/**
 * Play report 2 #10: a consolidated tool's outer schema is shared by every
 * action, so a key one action does not declare used to vanish between the
 * tool boundary and the handler under a success banner. An action that opts
 * in (unknownKeys: 'warn') still runs, but its reply carries ignoredParams
 * and a message line naming each key with the nearest valid key or the
 * action's own hint. Every other action's reply shape is unchanged.
 */
describe('action router unknownKeys', () => {
    const ACTIONS = ['create', 'update'] as const;
    const router = createActionRouter({
        actions: ACTIONS,
        definitions: {
            create: {
                schema: z.object({ action: z.string(), name: z.string(), conditions: z.array(z.string()).optional() }),
                handler: async (args: { name: string }) => ({ success: true, name: args.name, message: `Created ${args.name}.` }),
                unknownKeys: 'warn',
                unknownKeyHints: { preview: 'update-only — create always writes' }
            },
            update: {
                schema: z.object({ action: z.string(), id: z.string() }),
                handler: async (args: { id: string }) => ({ success: true, id: args.id })
            }
        }
    });
    const call = async (args: Record<string, unknown>) => JSON.parse((await router(args)).content[0].text);

    it('a warn action reports the keys its schema dropped and still runs the handler', async () => {
        const r = await call({ action: 'create', name: 'X', preview: true, conditons: ['typo'], sessionId: 's', nothing: undefined });
        expect(r.success).toBe(true);
        expect(r.name).toBe('X');
        expect(r.ignoredParams).toEqual(['preview', 'conditons']);
        expect(r.message).toBe("Created X. Ignored params (not create parameters; nothing was written for them): preview — update-only — create always writes; conditons — nearest valid key 'conditions'.");
    });

    it('no extra keys: the reply is untouched', async () => {
        const r = await call({ action: 'create', name: 'X' });
        expect(r.ignoredParams).toBeUndefined();
        expect(r.message).toBe('Created X.');
    });

    it('an action without the opt-in strips silently, as before', async () => {
        const r = await call({ action: 'update', id: 'u1', preview: true });
        expect(r).toEqual({ success: true, id: 'u1' });
    });

    it('helpers: envelope keys never count; a key with no close match says so', () => {
        const schema = z.object({ action: z.string(), name: z.string() });
        expect(ignoredParamsOf(schema, { action: 'create', name: 'X', sessionId: 's', output_mode: 'lean', outputMode: 'json', fields: ['name'], opId: 'op', zzz: 1 })).toEqual(['zzz']);
        expect(describeIgnoredParams('create', ['zzz'], schema)).toBe("Ignored params (not create parameters; nothing was written for them): zzz — no close match among create's parameters.");
    });
});
