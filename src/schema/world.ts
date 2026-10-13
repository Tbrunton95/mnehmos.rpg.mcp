import { z } from 'zod';
import { similarity } from '../utils/fuzzy-enum.js';

/** Canonical persisted world-environment contract shared by storage and tools. */
export const WorldEnvironmentSchema = z.object({
  // Campaign clock: day number plus HH:MM. world_manage update derives
  // elapsedHours from these, and session_manage surfaces due schedules by day.
  day: z.number().optional(),
  time: z.string().optional(),
  date: z.string().optional(),
  timeOfDay: z.string().optional(),
  season: z.string().optional(),
  moonPhase: z.string().optional(),
  weatherConditions: z.string().optional(),
  temperature: z.string().optional(),
  lighting: z.string().optional(),
  // Deep One audit request 2: the era label world_manage era_jump writes
  // ('M42, after the Drowning'); boot, the status block and clockWarning show it.
  era: z.string().optional(),
  // Play report 2, #14: where the party is, as free text ('Vorago docks').
  // The status block, boot and get_context show it when no room says otherwise.
  location: z.string().optional(),
  // Play report 5 #5: how a dying tracked combatant's slot behaves on advance
  // in this world: auto (the engine rolls the death save) | prompt (DEATH
  // SAVE DUE, advance refused until death_save). A character's own
  // combat_profile.deathSaveMode overrides it.
  deathSaveMode: z.enum(['auto', 'prompt']).optional(),
}).strict();

export type WorldEnvironment = z.infer<typeof WorldEnvironmentSchema>;

/** The canonical keys, in contract order. */
export const ENV_KEYS = Object.keys(WorldEnvironmentSchema.shape) as Array<keyof WorldEnvironment>;

/**
 * Spellings the tools accept for a canonical key: the retired contract's
 * names and the ones GMs reach for. normalizeWorldEnvironment reads them
 * from stored rows; applyEnvAliases renames them on a world_manage update.
 */
export const ENV_ALIASES: Readonly<Record<string, keyof WorldEnvironment>> = {
  weather: 'weatherConditions',
  currentDay: 'day',
  dayNightCycle: 'timeOfDay',
  currentLocation: 'location',
  place: 'location',
};

/** Normalize rows written by the retired world_manage environment contract. */
export function normalizeWorldEnvironment(value: unknown): WorldEnvironment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of ENV_KEYS) {
    const aliases = Object.entries(ENV_ALIASES).filter(([, to]) => to === key).map(([from]) => from);
    const candidate = [key, ...aliases].map(name => source[name]).find(candidate => candidate !== undefined);
    if (candidate !== undefined) canonical[key] = candidate;
  }
  return WorldEnvironmentSchema.parse(canonical);
}

/**
 * Rename alias keys to their canonical key. An alias whose canonical key is
 * absent is renamed; one that repeats the canonical value is dropped; one
 * that disagrees with it is kept, so the patch schema can refuse the pair.
 * `aliased` records every rename (alias → canonical) for the reply.
 */
export function applyEnvAliases(raw: unknown): { value: unknown; aliased: Record<string, string> } {
  const aliased: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, aliased };
  const value: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [alias, canonical] of Object.entries(ENV_ALIASES)) {
    if (!(alias in value)) continue;
    if (!(canonical in value)) {
      value[canonical] = value[alias];
      delete value[alias];
      aliased[alias] = canonical;
    } else if (value[canonical] === value[alias]) {
      delete value[alias];
      aliased[alias] = canonical;
    }
  }
  return { value, aliased };
}

const ALIAS_NOTE = 'weather is accepted as an alias of weatherConditions; currentLocation and place of location';

/**
 * The patch world_manage update takes: aliases renamed first, then every
 * canonical key optional, and an unknown key refused by name with the
 * nearest accepted key, instead of zod's bare "Unrecognized key(s)".
 */
export const EnvironmentPatchSchema = z.preprocess(
  (v) => applyEnvAliases(v).value,
  WorldEnvironmentSchema.partial().passthrough().superRefine((obj, ctx) => {
    const known = new Set<string>(ENV_KEYS);
    for (const key of Object.keys(obj)) {
      if (known.has(key)) continue;
      if (key in ENV_ALIASES) {
        const canonical = ENV_ALIASES[key];
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `environment.${key} and environment.${canonical} were both given with different values; pass one of ${key} / ${canonical}` });
        continue;
      }
      const candidates = [...ENV_KEYS, ...Object.keys(ENV_ALIASES)];
      const best = candidates.map(c => ({ c, s: similarity(key, c) })).sort((a, b) => b.s - a.s)[0];
      const canonical = ENV_ALIASES[best.c] ?? best.c;
      const via = ENV_ALIASES[best.c] ? ` (you may also write it as '${best.c}')` : '';
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: [key],
        message: `environment.${key} is not a world environment key. Did you mean '${canonical}'${via}? Accepted: ${ENV_KEYS.join(', ')} (${ALIAS_NOTE})`
      });
    }
  })
);

export const WorldSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  seed: z.string().min(1),
  width: z.number().positive(),
  height: z.number().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  environment: z.preprocess(normalizeWorldEnvironment, WorldEnvironmentSchema).optional(),
});

export type World = z.infer<typeof WorldSchema>;
