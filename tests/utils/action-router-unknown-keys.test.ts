import { z } from 'zod';
import { createActionRouter, describeIgnoredParams, ignoredParamsOf, formatValidationError } from '../../src/utils/action-router.js';

/**
 * Play report 2 #10 / play report 4 #2: a consolidated tool's outer schema is
 * shared by every action, so a key one action does not declare used to vanish
 * between the tool boundary and the handler under a success banner. Warning
 * is now the router's default: every action still runs, but its reply carries
 * ignoredParams and a message line naming each key with the nearest valid key
 * or the action's own hint. An action opts OUT with unknownKeys: 'strip'.
 */
describe('action router unknownKeys', () => {
    const ACTIONS = ['create', 'update', 'archive', 'tag', 'open'] as const;
    const router = createActionRouter({
        actions: ACTIONS,
        definitions: {
            create: {
                schema: z.object({ action: z.string(), name: z.string(), conditions: z.array(z.string()).optional() }),
                handler: async (args: { name: string }) => ({ success: true, name: args.name, message: `Created ${args.name}.` }),
                unknownKeyHints: { preview: 'update-only — create always writes' }
            },
            update: {
                schema: z.object({ action: z.string(), id: z.string() }),
                handler: async (args: { id: string }) => ({ success: true, id: args.id })
            },
            archive: {
                schema: z.object({ action: z.string(), id: z.string() }),
                handler: async (args: { id: string }) => ({ success: true, id: args.id }),
                unknownKeys: 'strip'
            },
            // world_manage update / agent_manage: the object sits behind preprocess and refine.
            tag: {
                schema: z.preprocess(v => v, z.object({ action: z.string(), id: z.string(), tag: z.string() }).refine(() => true)),
                handler: async (args: { id: string; tag: string }) => ({ success: true, id: args.id, tag: args.tag, message: `Tagged ${args.id}.` })
            },
            // A passthrough object keeps every key: nothing is ignored, so nothing is reported.
            open: {
                schema: z.object({ action: z.string(), id: z.string() }).passthrough(),
                handler: async (args: Record<string, unknown>) => ({ success: true, ...args })
            }
        }
    });
    const call = async (args: Record<string, unknown>) => JSON.parse((await router(args)).content[0].text);

    it('warn is the default: the keys the schema dropped are reported and the handler still runs', async () => {
        const r = await call({ action: 'create', name: 'X', preview: true, conditons: ['typo'], sessionId: 's', nothing: undefined });
        expect(r.success).toBe(true);
        expect(r.name).toBe('X');
        expect(r.ignoredParams).toEqual(['preview', 'conditons']);
        expect(r.message).toBe("Created X. Ignored params (not create parameters; nothing was written for them): preview — update-only — create always writes; conditons — nearest valid key 'conditions'.");
    });

    // The operation guard reads args.worldId before any action does, to stamp
    // roll_log.world_id on the dice the call rolls. An action that does not
    // take worldId still reports it, but says what the envelope did with it
    // instead of "no close match": the note must not claim the key did nothing.
    it("worldId sent to an action without it names the dice-log stamp, not 'no close match'", async () => {
        const r = await call({ action: 'update', id: 'u1', worldId: 'w-1' });
        expect(r.success).toBe(true);
        expect(r.ignoredParams).toEqual(['worldId']);
        expect(r.message).toBe("Ignored params (not update parameters; nothing was written for them): worldId — not among update's parameters; it only stamps this call's dice log (roll_log.world_id).");
        // An action's own hint for the key still wins.
        const hinted = createActionRouter({
            actions: ['get'] as const,
            definitions: { get: { schema: z.object({ action: z.string(), id: z.string() }), handler: async (a: { id: string }) => ({ success: true, id: a.id }), unknownKeyHints: { worldId: 'get reads the row by id alone' } } }
        });
        expect(JSON.parse((await hinted({ action: 'get', id: 'u1', worldId: 'w-1' })).content[0].text).message).toBe("Ignored params (not get parameters; nothing was written for them): worldId — get reads the row by id alone.");
    });

    it('no extra keys: the reply is untouched', async () => {
        const r = await call({ action: 'create', name: 'X' });
        expect(r.ignoredParams).toBeUndefined();
        expect(r.message).toBe('Created X.');
    });

    it('an action with no message of its own gets the note as its message', async () => {
        const r = await call({ action: 'update', id: 'u1', preview: true });
        expect(r).toEqual({
            success: true, id: 'u1', ignoredParams: ['preview'],
            message: "Ignored params (not update parameters; nothing was written for them): preview — no close match among update's parameters."
        });
    });

    it("an action that opts out with unknownKeys: 'strip' drops silently, as before", async () => {
        const r = await call({ action: 'archive', id: 'u1', preview: true });
        expect(r).toEqual({ success: true, id: 'u1' });
    });

    it('a schema behind preprocess and refine (ZodEffects) is read through to its object', async () => {
        const r = await call({ action: 'tag', id: 'u1', tag: 't', tagg: 'x' });
        expect(r.success).toBe(true);
        expect(r.ignoredParams).toEqual(['tagg']);
        expect(r.message).toBe("Tagged u1. Ignored params (not tag parameters; nothing was written for them): tagg — nearest valid key 'tag'.");
    });

    it('a passthrough schema keeps its keys, so none are reported', async () => {
        const r = await call({ action: 'open', id: 'u1', extra: 1 });
        expect(r).toEqual({ success: true, action: 'open', id: 'u1', extra: 1 });
    });

    it("a router-level unknownKeys: 'strip' applies to every action that has no setting of its own", async () => {
        const quiet = createActionRouter({
            actions: ['update', 'create'] as const,
            unknownKeys: 'strip',
            definitions: {
                update: { schema: z.object({ action: z.string(), id: z.string() }), handler: async (a: { id: string }) => ({ success: true, id: a.id }) },
                create: { schema: z.object({ action: z.string(), name: z.string() }), handler: async (a: { name: string }) => ({ success: true, name: a.name }), unknownKeys: 'warn' }
            }
        });
        expect(JSON.parse((await quiet({ action: 'update', id: 'u1', bogus: 1 })).content[0].text)).toEqual({ success: true, id: 'u1' });
        expect(JSON.parse((await quiet({ action: 'create', name: 'n', bogus: 1 })).content[0].text).ignoredParams).toEqual(['bogus']);
    });

    // Play report 7 #2: a handler that reports keys it dropped itself (nested
    // participant keys at combat_manage create) keeps them; the router's
    // top-level keys are added after, never written over them.
    it("a handler's own ignoredParams are merged with the router's, not overwritten", async () => {
        const nested = createActionRouter({
            actions: ['create'] as const,
            definitions: {
                create: {
                    schema: z.object({ action: z.string(), name: z.string() }),
                    handler: async (a: { name: string }) => ({
                        success: true, name: a.name, ignoredParams: ['participants[1].str'],
                        message: "Created. Ignored params (not participant keys; nothing was written for them): participants[1].str — an ability score."
                    })
                }
            }
        });
        const both = JSON.parse((await nested({ action: 'create', name: 'X', nmae: 'Y' })).content[0].text);
        expect(both.ignoredParams).toEqual(['participants[1].str', 'nmae']);
        expect(both.message).toContain('participants[1].str — an ability score');
        expect(both.message).toContain("nmae — nearest valid key 'name'");
        const own = JSON.parse((await nested({ action: 'create', name: 'X' })).content[0].text);
        expect(own.ignoredParams).toEqual(['participants[1].str']);
    });

    // Review: a key the handler already named is not listed (or noted) twice.
    it('a top-level key the handler already reported is not listed or noted twice', async () => {
        const self = createActionRouter({
            actions: ['create'] as const,
            definitions: {
                create: {
                    schema: z.object({ action: z.string(), name: z.string() }),
                    handler: async (a: { name: string }) => ({
                        success: true, name: a.name, ignoredParams: ['nmae'],
                        message: "Created. Ignored params (not create parameters; nothing was written for them): nmae — nearest valid key 'name'."
                    })
                }
            }
        });
        const one = JSON.parse((await self({ action: 'create', name: 'X', nmae: 'Y' })).content[0].text);
        expect(one.ignoredParams).toEqual(['nmae']);
        expect(one.message.split('nmae —').length - 1).toBe(1);
        const two = JSON.parse((await self({ action: 'create', name: 'X', nmae: 'Y', bogus: 1 })).content[0].text);
        expect(two.ignoredParams).toEqual(['nmae', 'bogus']);
        expect(two.message.split('nmae —').length - 1).toBe(1);
        expect(two.message).toContain('bogus —');
    });

    it('an error reply is never decorated', async () => {
        const failing = createActionRouter({
            actions: ['boom'] as const,
            definitions: { boom: { schema: z.object({ action: z.string() }), handler: async () => ({ error: true, message: 'no' }) } }
        });
        expect(JSON.parse((await failing({ action: 'boom', bogus: 1 })).content[0].text)).toEqual({ error: true, message: 'no' });
    });

    it('helpers: envelope keys never count; a key with no close match says so; open schemas report nothing', () => {
        const schema = z.object({ action: z.string(), name: z.string() });
        expect(ignoredParamsOf(schema, { action: 'create', name: 'X', sessionId: 's', output_mode: 'lean', outputMode: 'json', fields: ['name'], opId: 'op', zzz: 1 })).toEqual(['zzz']);
        expect(describeIgnoredParams('create', ['zzz'], schema)).toBe("Ignored params (not create parameters; nothing was written for them): zzz — no close match among create's parameters.");
        const wrapped = z.preprocess(v => v, schema.refine(() => true));
        expect(ignoredParamsOf(wrapped, { action: 'create', name: 'X', nmae: 'Y' })).toEqual(['nmae']);
        expect(describeIgnoredParams('create', ['nmae'], wrapped)).toContain("nmae — nearest valid key 'name'");
        expect(ignoredParamsOf(schema.passthrough(), { action: 'create', name: 'X', zzz: 1 })).toEqual([]);
        expect(ignoredParamsOf(schema.catchall(z.number()), { action: 'create', name: 'X', zzz: 1 })).toEqual([]);
        expect(ignoredParamsOf(z.string(), { zzz: 1 })).toEqual([]);
    });

    it('a validation error names the unknown keys, and a missing required key its misspelt twin', async () => {
        const r = await call({ action: 'create', nmae: 'X', preview: true });
        expect(r.error).toBe('validation_error');
        expect(r.writes).toBe('none');
        expect(r.unknownParams).toEqual(['nmae', 'preview']);
        const name = r.issues.find((i: { path: string }) => i.path === 'name');
        expect(name.message).toBe("Required — you sent 'nmae'; did you mean 'name'?");
        expect(r.hint).toBe("Check the parameter types and required fields. Unknown keys (not create parameters): nmae — nearest valid key 'name'; preview — update-only — create always writes.");
    });

    it('formatValidationError without the schema reads as before', () => {
        const err = z.object({ name: z.string() }).safeParse({});
        const r = JSON.parse(formatValidationError('create', (err as { error: z.ZodError }).error).content[0].text);
        expect(r.hint).toBe('Check the parameter types and required fields');
        expect(r.unknownParams).toBeUndefined();
        expect(r.issues[0]).toEqual({ path: 'name', message: 'Required', code: 'invalid_type' });
    });
});
