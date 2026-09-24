/**
 * TABLE_RULES — a world's house rules as data the engine enforces.
 *
 * The engine computes the numbers (bands, peer consequences due, called-strike
 * cripples, prepared-asset tiers, milestone XP, compact status); the table
 * owns the flavour. `principle` rules are reference text shown at session
 * boot and never enforced.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { SessionContext } from '../types.js';
import { RULE_KINDS, RuleKind, parseRuleSpec, listRules, TableRule, findPool } from '../../engine/table-rules.js';
import { RULE_PRESETS } from '../../data/table-rules/day-366.js';

const ACTIONS = ['define', 'get', 'list', 'enable', 'disable', 'delete', 'import'] as const;

const RuleEntrySchema = z.object({
    kind: z.string(),
    name: z.string().min(1),
    spec: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional()
});

const TableRulesInputSchema = z.object({
    action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
    worldId: z.string().describe('REQUIRED: rules are world-scoped'),
    name: z.string().optional().describe('define/get/enable/disable/delete: the rule name (unique per world)'),
    kind: z.string().optional().describe(`define: ${RULE_KINDS.join(', ')}. list: filter by kind`),
    spec: z.record(z.string(), z.unknown()).optional().describe('define: the rule parameters for its kind; omitted fields take defaults'),
    enabled: z.boolean().optional().describe('define: start enabled (default true)'),
    preset: z.string().optional().describe(`import: a bundled rule set (${Object.keys(RULE_PRESETS).join(', ')})`),
    rules: z.array(RuleEntrySchema).optional().describe('import: rules given inline, [{kind, name, spec}]'),
    sessionId: z.string().optional()
});

type Input = z.infer<typeof TableRulesInputSchema>;

/**
 * A status block naming a pool nobody carries shows nothing, silently. Say so
 * at define time. Untagged characters count, as they do everywhere else.
 */
function missingPoolWarning(worldId: string, corePool: unknown): string | undefined {
    if (typeof corePool !== 'string' || !corePool) return undefined;
    const db = getDb();
    let rows: Array<{ resource_pools?: string | null }>;
    try {
        rows = db.prepare('SELECT resource_pools FROM characters WHERE world_id = ? OR world_id IS NULL').all(worldId) as typeof rows;
    } catch {
        try { rows = db.prepare('SELECT resource_pools FROM characters').all() as typeof rows; } catch { return undefined; }
    }
    const found = rows.some(r => {
        try { return !!findPool(JSON.parse(r.resource_pools || '{}'), corePool); } catch { return false; }
    });
    return found ? undefined : `no character in this world has pool '${corePool}'; the block will omit it until one does`;
}

function view(r: TableRule) {
    return { name: r.name, kind: r.kind, enabled: r.enabled, spec: r.spec };
}

function upsert(input: { worldId: string; kind: string; name: string; spec?: Record<string, unknown>; enabled?: boolean }): { created: boolean } {
    if (!(RULE_KINDS as string[]).includes(input.kind)) {
        throw new Error(`Unknown rule kind '${input.kind}'. Kinds: ${RULE_KINDS.join(', ')}`);
    }
    const spec = parseRuleSpec(input.kind as RuleKind, input.spec ?? {});
    const db = getDb();
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id FROM table_rules WHERE world_id = ? AND name = ?').get(input.worldId, input.name) as { id: string } | undefined;
    if (existing) {
        db.prepare('UPDATE table_rules SET kind = ?, spec = ?, enabled = ?, updated_at = ? WHERE id = ?')
            .run(input.kind, JSON.stringify(spec), input.enabled === false ? 0 : 1, now, existing.id);
        return { created: false };
    }
    db.prepare('INSERT INTO table_rules (id, world_id, kind, name, spec, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), input.worldId, input.kind, input.name, JSON.stringify(spec), input.enabled === false ? 0 : 1, now, now);
    return { created: true };
}

function findRule(worldId: string, name?: string): TableRule | undefined {
    if (!name) return undefined;
    return listRules(getDb(), worldId).find(r => r.name.toLowerCase() === name.toLowerCase());
}

async function route(args: unknown): Promise<Record<string, unknown>> {
    const input: Input = TableRulesInputSchema.parse(args);
    const db = getDb();

    switch (input.action) {
        case 'define': case 'set': case 'upsert': {
            if (!input.kind || !input.name) return { error: true, message: 'define needs kind and name' };
            const { created } = upsert({ worldId: input.worldId, kind: input.kind, name: input.name, spec: input.spec, enabled: input.enabled });
            const rule = findRule(input.worldId, input.name)!;
            const warning = rule.kind === 'status_block' ? missingPoolWarning(input.worldId, (rule.spec as { corePool?: unknown }).corePool) : undefined;
            return { success: true, actionType: 'define', created, rule: view(rule), ...(warning ? { warning } : {}), message: `${created ? 'Defined' : 'Updated'} ${rule.kind} rule '${rule.name}'` };
        }
        case 'get': {
            const rule = findRule(input.worldId, input.name);
            if (!rule) return { error: true, message: `No rule '${input.name}' in this world` };
            return { success: true, actionType: 'get', rule: view(rule) };
        }
        case 'list': {
            const rules = listRules(db, input.worldId).filter(r => !input.kind || r.kind === input.kind);
            return { success: true, actionType: 'list', count: rules.length, rules: rules.map(view), message: `${rules.length} rule(s)` };
        }
        case 'enable': case 'disable': {
            const rule = findRule(input.worldId, input.name);
            if (!rule) return { error: true, message: `No rule '${input.name}' in this world` };
            db.prepare('UPDATE table_rules SET enabled = ?, updated_at = ? WHERE id = ?')
                .run(input.action === 'enable' ? 1 : 0, new Date().toISOString(), rule.id);
            return { success: true, actionType: input.action, name: rule.name, enabled: input.action === 'enable', message: `'${rule.name}' ${input.action}d` };
        }
        case 'delete': {
            const rule = findRule(input.worldId, input.name);
            if (!rule) return { error: true, message: `No rule '${input.name}' in this world` };
            db.prepare('DELETE FROM table_rules WHERE id = ?').run(rule.id);
            return { success: true, actionType: 'delete', name: rule.name, message: `'${rule.name}' deleted` };
        }
        case 'import': {
            let entries = input.rules;
            if (!entries && input.preset) {
                entries = RULE_PRESETS[input.preset.toLowerCase()];
                if (!entries) return { error: true, message: `No preset '${input.preset}'. Presets: ${Object.keys(RULE_PRESETS).join(', ')}` };
            }
            if (!entries?.length) return { error: true, message: 'import needs preset or rules' };
            // Validate every entry before writing any, so a bad entry never
            // leaves a half-imported rule set.
            for (const e of entries) {
                if (!(RULE_KINDS as string[]).includes(e.kind)) throw new Error(`Rule '${e.name}': unknown kind '${e.kind}'`);
                parseRuleSpec(e.kind as RuleKind, e.spec ?? {});
            }
            let created = 0, updated = 0;
            db.transaction(() => {
                for (const e of entries!) {
                    const r = upsert({ worldId: input.worldId, kind: e.kind, name: e.name, spec: e.spec, enabled: e.enabled });
                    if (r.created) created++; else updated++;
                }
            })();
            return { success: true, actionType: 'import', preset: input.preset, created, updated, message: `Imported ${entries.length} rule(s): ${created} new, ${updated} updated` };
        }
    }
    return { error: true, message: `Unknown action '${input.action}': ${ACTIONS.join(', ')}` };
}

export async function handleTableRules(args: unknown, _ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const result = await route(args);
        let output = result.error
            ? RichFormatter.error(String(result.message))
            : RichFormatter.header(`Table Rules: ${String(result.actionType)}`, '📜') + (result.message ? RichFormatter.alert(String(result.message), 'info') : '')
            + (result.warning ? RichFormatter.alert(String(result.warning), 'warning') : '');
        if (!result.error && Array.isArray(result.rules)) {
            output += RichFormatter.list((result.rules as Array<ReturnType<typeof view>>).map(r =>
                `${r.enabled ? '●' : '○'} ${r.name} [${r.kind}]${r.kind === 'principle' ? `: ${String((r.spec as { text?: string }).text ?? '')}` : ''}`));
        }
        output += RichFormatter.embedJson(result, 'TABLE_RULES');
        return { content: [{ type: 'text', text: output }] };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: RichFormatter.error(msg) + RichFormatter.embedJson({ error: true, message: msg }, 'TABLE_RULES') }] };
    }
}

export const TableRulesTool = {
    name: 'table_rules',
    description: `A world's house rules as data the engine enforces. The engine computes the numbers; the table owns the flavour.

Actions: define, get, list, enable, disable, delete, import
Kinds:
- band {order}: power bands, lowest first. Characters and combat tokens carry band.
- peer_consequence {thresholdFraction, onCrit, options}: a hit on a peer (same band or higher) that crits or deals ≥ the fraction of max HP flags CONSEQUENCE DUE; the GM names it and applies it with combat_manage set_part.
- called_strike {requirePeer, limbs}: combat_action attack calledStrike: 'leg'|'arm' cripples that limb on a hit (no roll penalty, no threshold).
- prepared_asset {catastrophicMargin, missOptions, hitEffect, catastrophicEffect}: combat_action attack preparedAsset: <rule name> reports the tier (miss / hit / catastrophic); the GM names the effect.
- progression {mode: 'milestone'}: add_xp stops offering level-ups.
- status_block {compact, maxConditions, corePool}: tiny status blocks; corePool names the one resource pool shown (any case).
- lexicon {currency, badge, questFailLine}: the world's words for fixed labels (currency on the gold field, the status block's header badge, the quest-failed line). Without one a world reads RU, ПДА and "The Zone doesn't wait."
- principle {text}: reference text shown at session boot, never enforced.
import {worldId, preset: 'day-366'} loads the Day 366 table rules. worldId REQUIRED on every call.`,
    inputSchema: TableRulesInputSchema,
    // Every action shares the one input schema; the switch dispatcher validates per action.
    actionSchemas: Object.fromEntries(ACTIONS.map(a => [a, { schema: TableRulesInputSchema, aliases: [] as string[] }]))
};
