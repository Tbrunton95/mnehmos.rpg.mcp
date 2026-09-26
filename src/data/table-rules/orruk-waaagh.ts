/**
 * TABLE RULES: ORRUK WAAAGH! — a homebrew greenskin rule set for a 5e-scale
 * table, in the spirit of the owner's Orruk warclans (Grimgor, Wurrzag,
 * Azhag). `table_rules import {worldId, preset: 'orruk-waaagh'}` writes it
 * into a world. Every name and number here is the table's own homebrew.
 *
 * What it gives: Gorkamorka as one god with two faces (no jealousy), teef as
 * currency, Orruk and Grot species, four classes, a band ladder, forms from
 * Ardboy to Great Warboss (the Getting Bigga track offers each in turn), the
 * Waaagh! Overload miscast table and three spells that feed on the boyz
 * around the caster. The Waaagh! call itself is combat_manage battle_cry
 * (see docs/table-rules/orruk-waaagh.md).
 */
import type { RulePresetEntry } from './day-366.js';

const principles: Array<[string, string]> = [
    ['orks-get-bigga', "Orks get bigga by fightin'. Kills and victories feed the growth pool; when it crosses a step the engine offers the next form, and the player decides when to take it."],
    ['gorkamorka-favours', "Gorkamorka favours the strong and the kunnin'. Gork (brutal but kunnin') and Mork (kunnin' but brutal) are one god: favour to one never angers the other."],
    ['da-waaagh', 'The Waaagh! is loud. The more boyz around a shaman, the harder his magic hits and the likelier it is to blow his head open; the more boyz in a mob, the harder it is to break.'],
];

const orruk = (spec: Record<string, unknown>) => ({ species: 'Orruk', traits: ['Tough as Old Boots'], resistances: [], vulnerabilities: [], immunities: [], ...spec });

export const ORRUK_WAAAGH_PRESET: RulePresetEntry[] = [
    { kind: 'band', name: 'orruk-bands', spec: { order: ['Grot', 'Boy', 'Brute', 'Boss', 'Warboss'] } },
    { kind: 'lexicon', name: 'lexicon', spec: { currency: 'teef', badge: 'WAAAGH!', questFailLine: '' } },
    {
        kind: 'pool_family', name: 'Gorkamorka', spec: {
            pools: ['gork', 'mork'],
            jealousy: {},
            offering_values: { kill: 1, 'big kill': 3, loot: 1 }
        }
    },

    // ── Species ──
    {
        kind: 'species', name: 'Orruk', spec: {
            size: 'medium', speed: 30, abilityBonuses: { str: 2, con: 1 }, languages: ['Orruk'],
            traits: ['Tough as Old Boots', 'Waaagh!']
        }
    },
    {
        kind: 'species', name: 'Grot', spec: {
            size: 'small', speed: 30, abilityBonuses: { dex: 2 }, languages: ['Orruk'],
            traits: ['Sneaky Git', 'Runt']
        }
    },

    // ── Classes (world spells need no slots, so the casters take no casting.as) ──
    { kind: 'char_class', name: 'Brute', spec: { hitDie: 12, saves: ['str', 'con'], skills: ['Athletics', 'Intimidation'], armor: ['light', 'medium', 'heavy', 'shields'], weapons: ['simple', 'martial'] } },
    { kind: 'char_class', name: 'Ardboy', spec: { hitDie: 10, saves: ['str', 'con'], skills: ['Athletics'], armor: ['light', 'medium', 'heavy', 'shields'], weapons: ['simple', 'martial'] } },
    { kind: 'char_class', name: 'Wurrgog Prophet', spec: { hitDie: 8, saves: ['con', 'wis'], skills: ['Religion', 'Intimidation'], armor: ['light'], weapons: ['simple'] } },
    { kind: 'char_class', name: 'Weirdnob Shaman', spec: { hitDie: 8, saves: ['con', 'wis'], skills: ['Arcana', 'Intimidation'], armor: ['light'], weapons: ['simple'] } },

    // ── Getting Bigga: kills and victories grow an Orruk ──
    {
        kind: 'growth_track', name: 'Getting Bigga', spec: {
            pool: 'growth', perKill: 1, perBandAbove: 1, perVictory: 2,
            steps: [
                { at: 10, form: 'Orruk Brute', note: 'Big enough for brute armour and a proper choppa' },
                { at: 30, form: 'Orruk Megaboss', note: 'Too big to argue with: a boss of a mob' },
                { at: 60, form: 'Great Warboss', note: 'The Waaagh! follows him now' }
            ]
        }
    },

    // ── Forms and foes: Ardboy (CR 1) up to Great Warboss (CR 13) ──
    {
        kind: 'creature', name: 'Orruk Ardboy', spec: orruk({
            hp: 22, ac: 15, size: 'medium', movementSpeed: 30, cr: 1, xpValue: 200, band: 'Boy',
            stats: { str: 16, dex: 10, con: 16, int: 8, wis: 10, cha: 10 },
            attacks: [
                { name: 'choppa', attackBonus: 5, damage: '1d8+3', damageType: 'slashing', default: true },
                { name: 'shield bash', attackBonus: 5, damage: '1d4+3', damageType: 'bludgeoning' }
            ]
        })
    },
    {
        kind: 'creature', name: 'Orruk Brute', spec: orruk({
            hp: 52, ac: 16, size: 'medium', movementSpeed: 30, cr: 3, xpValue: 700, band: 'Brute',
            stats: { str: 18, dex: 10, con: 18, int: 8, wis: 10, cha: 11 },
            attacksPerAction: 2,
            attacks: [{ name: 'brute choppa', attackBonus: 6, damage: '2d6+4', damageType: 'slashing', default: true }],
            traits: ['Tough as Old Boots', 'Brute Armour']
        })
    },
    {
        kind: 'creature', name: 'Orruk Megaboss', spec: orruk({
            hp: 136, ac: 18, size: 'large', movementSpeed: 30, cr: 8, xpValue: 3900, band: 'Boss',
            stats: { str: 21, dex: 10, con: 20, int: 10, wis: 12, cha: 16 },
            attacksPerAction: 3,
            attacks: [
                { name: 'boss choppa', attackBonus: 9, damage: '2d10+5', damageType: 'slashing', default: true },
                { name: 'rip-toof fist', attackBonus: 9, damage: '2d6+5', damageType: 'bludgeoning' }
            ],
            abilities: [{ name: 'Waaagh!', recharge: 5 }],
            traits: ['Tough as Old Boots', 'Strength from Victory']
        })
    },
    {
        kind: 'creature', name: 'Great Warboss', spec: orruk({
            hp: 230, ac: 19, size: 'huge', movementSpeed: 40, cr: 13, xpValue: 10000, band: 'Warboss',
            stats: { str: 24, dex: 10, con: 22, int: 12, wis: 14, cha: 20 },
            attacksPerAction: 3,
            attacks: [
                { name: 'gork-toof cleaver', attackBonus: 12, damage: '3d10+7', damageType: 'slashing', default: true },
                { name: 'boss stompa', attackBonus: 12, damage: '3d8+7', damageType: 'bludgeoning' }
            ],
            abilities: [{ name: 'Waaagh!', recharge: 5 }],
            legendaryActions: 3,
            legendaryResistances: 2,
            traits: ['Tough as Old Boots', 'Da Biggest', 'Waaagh! Leader']
        })
    },

    // ── Magic ──
    {
        kind: 'roll_table', name: 'Waaagh! Overload', spec: {
            dice: '2d6',
            entries: [
                { min: 2, max: 4, text: "Da Jolt: green lightning arcs back through the caster, who is Stunned until the end of their next turn.", apply: { condition: { name: 'Stunned', duration: 1, source: 'Waaagh! Overload' } } },
                { min: 5, max: 9, text: 'Green Puke: the caster spews raw Waaagh! energy; each ally within 10 ft takes 1d6 acid (the GM applies it).' },
                { min: 10, max: 12, text: "Wot a Rush: the energy burns off in a howl; nothing worse than a headache and a very loud grin." }
            ]
        }
    },
    {
        kind: 'spell', name: 'Foot of Gork', spec: {
            castingRoll: {
                dice: '2d6', target: 7,
                bonusFromNearby: { range: 40, per: 3, max: 4, match: { species: 'Orruk' }, overloadAt: 4 }
            },
            contestedBy: 'unbind',
            range: 120,
            effects: [{ type: 'damage', dice: '4d6', damageType: 'bludgeoning', save: { ability: 'dex' }, saveEffect: 'half' }],
            miscast: { on: 'double', table: 'Waaagh! Overload' }
        }
    },
    {
        kind: 'spell', name: 'Green Puke', spec: {
            castingRoll: { dice: '2d6', target: 6 },
            contestedBy: 'unbind',
            range: 15,
            effects: [{ type: 'damage', dice: '2d6', damageType: 'acid', save: { ability: 'dex' }, saveEffect: 'half' }]
        }
    },
    {
        kind: 'spell', name: 'Mighty Waaagh!', spec: {
            castingRoll: { dice: '2d6', target: 8 },
            effects: [{ type: 'pool', pool: 'waaagh', delta: 2, target: 'caster' }]
        }
    },

    ...principles.map(([name, text]) => ({ kind: 'principle' as const, name, spec: { text } })),
];
