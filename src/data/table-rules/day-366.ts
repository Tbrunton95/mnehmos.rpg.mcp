/**
 * TABLE RULES: PROJECT RESET (Day 366) — the owner's 40k-on-5e table rules as
 * loadable table_rules definitions. `table_rules import {worldId, preset:
 * 'day-366'}` writes them into a world.
 *
 * Enforced kinds carry the numbers the engine computes; `principle` rules are
 * reference text surfaced at session boot and never enforced.
 */
import type { RuleKind } from '../../engine/table-rules.js';

export interface RulePresetEntry {
    kind: RuleKind;
    name: string;
    spec: Record<string, unknown>;
}

const principles: Array<[string, string]> = [
    ['fix-the-system', 'When rules and fiction disagree repeatedly, stop play and fix the system once; no local patches mid-encounter.'],
    ['character-fantasy', 'Luciel is an Astartes-scale warlord who dominates ordinary mortals physically. Peer transhumans are serious fights capable of maiming him. Chaos offers genuine shortcuts to power that become increasingly difficult to refuse. If a mechanic repeatedly contradicts these, change the mechanic.'],
    ['fiction-first', 'Roll only for real uncertainty; a roll never turns a meaningful fictional advantage into nothing unless total failure makes sense.'],
    ['mortal-units', 'Mortal units: one initiative, one move, one action; fixed volley tiers (healthy Scions 3d6-4d6; reduced by casualties, suppression, melee, broken formation); size affects staying power, area, lanes, splitting, suppression, objectives, not dice.'],
    ['cleave', 'Cleave through packed lower-band targets in a plausible arc; spacing prevents it; never on peers.'],
    ['peers', 'Peers are individual; significant hits create physical consequences (crippled joints, breached plate, thrown out of position); HP is endurance, not permission to ignore the body.'],
    ['geometry', 'Geometry before initiative; LOS binary; partial cover +2, hard +5; narrow exposure = disadvantage or no shot; no free fire through friends; melee disrupts a unit\'s fire.'],
    ['preparation', 'Preparation buys reliability: a prepared asset acting on the event it was prepared for always does something; the roll sets how much.'],
    ['success-stays-success', 'Success stays success; failure complicates.'],
    ['dice-resolve-intent', 'Dice resolve intent, not morality.'],
    ['chaos-pays-first', 'Chaos pays first; costs arrive later.'],
    ['npcs-are-characters', 'NPCs are characters, not consultants; no conscience chorus; no italic thoughts grading Luciel.'],
    ['threat-telegraphed', 'Threat intent is telegraphed.'],
    ['boss-phases', 'Bosses use phases.'],
    ['no-infinite-reinforcements', 'No infinite reinforcements; destroyed stays destroyed, broken rites stay broken.'],
    ['admin-montaged', 'Admin is montaged; time moves; every scene earns its place.'],
    ['declarations-sacred', 'Player declarations are sacred.'],
    ['fewer-heavier-rolls', 'Fewer, heavier rolls.'],
    ['gm-surprised', 'The GM may be surprised.'],
    ['regeneration', 'A regenerating creature heals its stated amount at the start of each of its rounds, in and out of combat; the encounter sheet applies it automatically (set the creature\'s regeneration value).'],
];

export const DAY_366_PRESET: RulePresetEntry[] = [
    { kind: 'band', name: 'bands', spec: { order: ['Mortal', 'Elite Mortal', 'Astartes', 'Astartes Elite', 'Monster/Lord', 'Primarch-class'] } },
    { kind: 'peer_consequence', name: 'peer-consequence', spec: { thresholdFraction: 0.25, onCrit: true, options: ['crippled joint', 'breached plate', 'thrown out of position'] } },
    {
        kind: 'called_strike', name: 'measure-of-a-body', spec: {
            requirePeer: true,
            limbs: {
                leg: { speed: 0.5, notes: ['no brace', 'footing/Athletics at disadvantage'] },
                arm: { attackDisadvantage: true, notes: ["that arm's attacks at disadvantage"] }
            }
        }
    },
    { kind: 'prepared_asset', name: 'prepared-anti-armour', spec: { catastrophicMargin: 10, missOptions: ['breach', 'displacement', 'forced into cover'], hitEffect: 'crippled system', catastrophicEffect: 'catastrophic' } },
    { kind: 'progression', name: 'milestone-xp', spec: { mode: 'milestone' } },
    { kind: 'status_block', name: 'tiny-status', spec: { compact: true, maxConditions: 2 } },
    ...principles.map(([name, text]) => ({ kind: 'principle' as const, name, spec: { text } })),
];

export const RULE_PRESETS: Record<string, RulePresetEntry[]> = {
    'day-366': DAY_366_PRESET,
};
