/**
 * The object behind a Zod wrapper.
 *
 * Action schemas are z.object() most of the time, but about twenty-five sit
 * behind z.preprocess / .refine (ZodEffects — every agent_manage action,
 * world_manage update and advance, combat_manage, character_manage …) and a
 * few behind .default / .optional / .brand. Their keys are inner params like
 * any other: the mirror audit needs them to check the outer schema, and the
 * ignored-key check needs them to say which keys a call dropped. Reading
 * `.shape` directly saw nothing there and silently reported nothing.
 */
type Def = {
    typeName?: string;
    schema?: unknown;
    innerType?: unknown;
    type?: unknown;
    in?: unknown;
    getter?: () => unknown;
    unknownKeys?: string;
    catchall?: { _def?: { typeName?: string } };
};
type Zodish = { shape?: Record<string, unknown> | (() => Record<string, unknown>); _def?: Def };

/** The innermost schema once every effects/default/optional/brand/pipeline wrapper is peeled. */
export function unwrapZod(schema: unknown): Zodish | undefined {
    let current = schema as Zodish | undefined;
    for (let depth = 0; depth < 32 && current?._def; depth++) {
        const def = current._def;
        let next: unknown;
        switch (def.typeName) {
            case 'ZodEffects': next = def.schema; break;
            case 'ZodDefault':
            case 'ZodOptional':
            case 'ZodNullable':
            case 'ZodReadonly':
            case 'ZodCatch': next = def.innerType; break;
            case 'ZodBranded': next = def.type; break;
            case 'ZodPipeline': next = def.in; break;
            case 'ZodLazy': next = def.getter?.(); break;
            default: return current;
        }
        if (!next) return current;
        current = next as Zodish;
    }
    return current;
}

/** The object shape a schema validates against, through its wrappers; undefined when there is no object. */
export function shapeOf(schema: unknown): Record<string, unknown> | undefined {
    const shape = unwrapZod(schema)?.shape;
    if (!shape) return undefined;
    return typeof shape === 'function' ? shape() : shape;
}

/**
 * True when the object keeps the keys it does not declare — .passthrough()
 * or a .catchall(...) — so an undeclared key reaches the handler and is not
 * ignored. The default strip object, and .strict(), return false.
 */
export function keepsUnknownKeys(schema: unknown): boolean {
    const inner = unwrapZod(schema);
    const def = inner?._def;
    if (!def || inner?.shape === undefined) return false;
    if (def.unknownKeys === 'passthrough') return true;
    const catchall = def.catchall;
    return !!catchall && catchall._def?.typeName !== 'ZodNever';
}
