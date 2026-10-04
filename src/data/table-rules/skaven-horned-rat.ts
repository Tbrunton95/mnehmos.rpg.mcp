/**
 * TABLE RULES: SKAVEN OF THE HORNED RAT — an Age of Sigmar Skaven rule set
 * for a 5e-scale table, for a Grey Seer climbing toward Verminlord.
 * `table_rules import {worldId, preset: 'skaven-horned-rat'}` writes it into
 * a world. Every number here is the table's own homebrew; the Age of Sigmar
 * casting values ride as the spells' 2d6 targets.
 *
 * What it gives: the Clanrat-to-Horned-Rat band ladder with damage scaled by
 * the gap, warp-tokens, the favour family (the Horned Rat's favour and the
 * Clan's standing are jealous of each other; warpstone taint is a third pool
 * outside the jealousy), Skaven and the Grey Seer class, Verminlord forms
 * the Ascension track offers, the Warpstone Hunger ladder whose auto rungs
 * twitch, burn, mutate and finally shrink the Seer into a Rat-Thing, a
 * bestiary from the Clanrat tide to the Boneripper, four tables and the
 * Lore of Ruin with (warpstone) variants that cost a token and a point of
 * taint. combat_action cast_spell {boost} spends a warpstone token on any
 * casting roll (see docs/table-rules/skaven-horned-rat.md).
 */
import type { RulePresetEntry } from './day-366.js';

const principles: Array<[string, string]> = [
    ['scheme', 'Scheme. Every Skaven at the table has a plan that profits them at a rival\'s expense; the GM plays each NPC\'s plan, never a conscience. The engine keeps the favour and standing; the table keeps the knives.'],
    ['blame', 'Blame. When a plan fails, a Skaven names a culprit before the dust settles. A failed cast, a broken tide or a lost shard costs clan_standing unless someone else is made to carry it; the knowledge ledger says who could know.'],
    ['flee', 'Flee. Skaven run when the odds turn, and running is not a failure: a tide that passes its break test still routs if the Seer says so, and Skitterleap exists for a reason. The Horned Rat rewards the survivor, not the martyr.'],
];

const skaven = (spec: Record<string, unknown>) => ({ species: 'skaven', resistances: [], vulnerabilities: [], immunities: [], ...spec });
const MISCAST = { on: 'double' as const, table: 'Warp Lightning Miscast' };
const seerSpells = ['Warp Lightning', 'Skitterleap', 'Wither', 'Death Frenzy', 'Plague', 'Curse of the Horned Rat', 'Dreaded Thirteenth Spell'];

export const SKAVEN_HORNED_RAT_PRESET: RulePresetEntry[] = [
    {
        kind: 'band', name: 'skaven-bands', spec: {
            order: ['Clanrat', 'Stormvermin', 'Packmaster', 'Warlock Engineer', 'Grey Seer', 'Verminlord', 'Horned Rat'],
            damageScale: { perStepBelow: 0.5, perStepAbove: 1.25, floor: 0.25, cap: 2 }
        }
    },
    { kind: 'lexicon', name: 'lexicon', spec: { currency: 'warp-tokens', badge: '≈≈', questFailLine: 'Yes-yes, it was never-never your plan anyway. Someone else will pay-suffer for it.' } },
    {
        kind: 'pool_family', name: 'favour', spec: {
            pools: ['horned_rat_favour', 'clan_standing', 'warpstone_taint'],
            floor: 0,
            // The Horned Rat and the Clan are jealous of each other; taint is
            // its own hunger and belongs to neither.
            jealousy: { horned_rat_favour: { clan_standing: 0.5 }, clan_standing: { horned_rat_favour: 0.5 } },
            offering_values: { 'warpstone shard': 2, slave: 1, "rival's tail": 5, "a Clan's secret": 3, kill: 1 }
        }
    },

    // ── Species, class, background ──
    {
        kind: 'species', name: 'skaven', spec: {
            size: 'medium', speed: 30, abilityBonuses: { dex: 2, int: 1 }, languages: ['Queekish'],
            traits: ['Scurry Away', 'Darkvision', 'Strength in Numbers']
        }
    },
    {
        kind: 'char_class', name: 'grey_seer', spec: {
            hitDie: 6, saves: ['int', 'wis'], skills: ['Arcana', 'Deception', 'Religion'], armor: [], weapons: ['simple'],
            castingAbility: 'int',
            spells: seerSpells
        }
    },
    { kind: 'background', name: 'Council whelp', spec: { skills: ['Insight', 'Persuasion'], languages: ['Queekish', 'Common'], tools: ['warpstone scales'], gold: 13 } },

    // ── Ascension: kills and victories feed the Horned Rat's favour ──
    {
        kind: 'growth_track', name: 'Ascension', spec: {
            pool: 'horned_rat_favour', perKill: 1, perBandAbove: 1, perVictory: 2,
            steps: [
                { at: 20, condition: { name: 'Grey Seer (ascendant)', effect: 'The Horned Rat watches: +1 on casting rolls at the GM\'s call; rival seers know the name' }, auto: true, note: 'Noticed by the Great Horned One' },
                { at: 50, form: 'Verminlord Warpseer', note: 'The offer of a daemon\'s shape: take it or stay a Seer with the Horned Rat\'s eye on you' },
                { at: 100, form: 'Verminlord Deceiver', note: 'The second shape: the Deceiver walks where it is not seen' }
            ]
        }
    },
    // ── Warpstone Hunger: an addiction ladder with auto rungs ──
    {
        kind: 'growth_track', name: 'Warpstone Hunger', spec: {
            pool: 'warpstone_taint',
            steps: [
                { at: 3, condition: { name: 'Twitching', effect: 'Hands shake: disadvantage on Sleight of Hand and on holding concentration' }, auto: true },
                { at: 6, condition: { name: 'Burning Eyes', effect: 'Eyes glow green in the dark: Stealth at disadvantage against anyone who can see them' }, auto: true },
                { at: 10, table: 'Mutation', auto: true, note: 'The warpstone takes a shape of its own' },
                { at: 15, form: 'Rat-Thing', auto: true, note: 'What is left when the warpstone has eaten the Seer' }
            ]
        }
    },

    // ── Forms ──
    {
        kind: 'creature', name: 'Grey Seer', spec: skaven({
            hp: 60, ac: 14, size: 'medium', movementSpeed: 30, cr: 7, xpValue: 2900, band: 'Grey Seer',
            stats: { str: 8, dex: 14, con: 10, int: 18, wis: 14, cha: 12 },
            attacks: [{ name: 'staff', attackBonus: 4, damage: '1d6+1', damageType: 'bludgeoning', default: true }],
            traits: ['Scurry Away', 'Lore of Ruin']
        })
    },
    {
        kind: 'creature', name: 'Verminlord Warpseer', spec: skaven({
            hp: 260, ac: 18, size: 'huge', movementSpeed: 50, cr: 18, xpValue: 20000, band: 'Verminlord',
            stats: { str: 22, dex: 18, con: 20, int: 22, wis: 18, cha: 20 },
            attacksPerAction: 3,
            attacks: [
                { name: 'Doomglaive', attackBonus: 12, damage: '3d10+6', damageType: 'slashing', default: true, reachFt: 10 },
                { name: 'Tail', attackBonus: 12, damage: '2d8+6', damageType: 'bludgeoning', reachFt: 15 }
            ],
            abilities: [{ name: 'Scry-Orb', recharge: 5 }],
            legendaryActions: 3,
            legendaryResistances: 3,
            hasLairActions: true,
            resistances: ['force'],
            traits: ['Daemon', 'Protection of the Horned Rat', 'Lore of Ruin'],
            tags: ['daemon', 'verminlord']
        })
    },
    {
        kind: 'creature', name: 'Verminlord Deceiver', spec: skaven({
            hp: 240, ac: 18, size: 'huge', movementSpeed: 60, cr: 18, xpValue: 20000, band: 'Verminlord',
            stats: { str: 20, dex: 22, con: 18, int: 20, wis: 16, cha: 22 },
            attacksPerAction: 3,
            attacks: [
                { name: 'Warpstiletto', attackBonus: 13, damage: '2d10+7', damageType: 'piercing', default: true },
                { name: 'Doomstar', attackBonus: 13, damage: '3d8+7', damageType: 'slashing', ranged: true }
            ],
            abilities: [{ name: 'Shrouded in Darkness', recharge: 5 }],
            legendaryActions: 3,
            legendaryResistances: 3,
            traits: ['Daemon', 'Protection of the Horned Rat', 'Dreaded Skitterleap'],
            tags: ['daemon', 'verminlord']
        })
    },
    {
        kind: 'creature', name: 'Verminlord Corruptor', spec: skaven({
            hp: 280, ac: 17, size: 'huge', movementSpeed: 50, cr: 18, xpValue: 20000, band: 'Verminlord',
            stats: { str: 22, dex: 16, con: 24, int: 18, wis: 16, cha: 18 },
            attacksPerAction: 2,
            attacks: [{ name: 'Plaguereapers', attackBonus: 12, damage: '4d8+6', damageType: 'slashing', default: true, reachFt: 10 }],
            abilities: [{ name: 'Plaguereaper Sweep', recharge: 5 }],
            legendaryActions: 3,
            legendaryResistances: 3,
            immunities: ['poison'],
            traits: ['Daemon', 'Protection of the Horned Rat', 'Plaguelord'],
            tags: ['daemon', 'verminlord']
        })
    },
    {
        kind: 'creature', name: 'Rat-Thing', spec: skaven({
            hp: 30, ac: 12, size: 'small', movementSpeed: 40, cr: 1, xpValue: 200, band: 'Clanrat',
            stats: { str: 6, dex: 16, con: 10, int: 6, wis: 8, cha: 4 },
            attacks: [{ name: 'bite', attackBonus: 4, damage: '1d6+2', damageType: 'piercing', default: true }],
            traits: ['Scurry Away', 'Warpstone-eaten'],
            tags: ['mutant']
        })
    },

    // ── Bestiary ──
    {
        kind: 'creature', name: 'Boneripper', spec: skaven({
            hp: 180, ac: 15, size: 'huge', movementSpeed: 40, cr: 11, xpValue: 7200, band: 'Packmaster',
            stats: { str: 24, dex: 10, con: 20, int: 4, wis: 8, cha: 6 },
            attacksPerAction: 3,
            attacks: [
                { name: 'warpfire projector', attackBonus: 8, damage: '4d6', damageType: 'fire', part: 'warpfire projector', ranged: true },
                { name: 'crushing fist', attackBonus: 11, damage: '2d10+7', damageType: 'bludgeoning', default: true, part: 'upper right arm' },
                { name: 'claw', attackBonus: 11, damage: '2d8+7', damageType: 'slashing', part: 'lower left arm' }
            ],
            parts: [
                { name: 'upper right arm', kind: 'arm', holds: ['crushing fist', 'mainhand'] },
                { name: 'upper left arm', kind: 'arm', holds: ['warpfire projector mount'] },
                { name: 'lower right arm', kind: 'arm', holds: ['claw'] },
                { name: 'lower left arm', kind: 'arm', holds: ['claw'] },
                { name: 'warpfire projector', kind: 'system', hp: 30, maxHp: 30, breakAt: 15, note: 'Crippled: no Warpfire Blast; broken: it detonates on the Boneripper (GM: 4d6 fire)' }
            ],
            abilities: [{ name: 'Warpfire Blast', recharge: 5, note: 'A 30 ft line from the projector; the part must be intact' }],
            traits: ['Warpstone-fed', 'Mindless'],
            tags: ['rat ogor', 'construct']
        })
    },
    {
        kind: 'creature', name: 'Clanrat tide', spec: skaven({
            hp: 160, ac: 12, size: 'large', movementSpeed: 30, cr: 5, xpValue: 1800, band: 'Clanrat',
            stats: { str: 10, dex: 14, con: 10, int: 8, wis: 8, cha: 6 },
            unit: { models: 40, hpPerModel: 4, packed: true, attackBonus: 3, breakAt: 0.5, morale: 6, mobRule: { per: 10, attackBonusPer: 20 } },
            traits: ['Strength in Numbers', 'Scurry Away'],
            tags: ['mob', 'tide']
        })
    },
    {
        kind: 'creature', name: 'Stormvermin block', spec: skaven({
            hp: 160, ac: 15, size: 'large', movementSpeed: 30, cr: 6, xpValue: 2300, band: 'Stormvermin',
            stats: { str: 14, dex: 12, con: 14, int: 8, wis: 10, cha: 8 },
            unit: { models: 20, hpPerModel: 8, packed: true, attackBonus: 5, breakAt: 0.5, morale: 8, mobRule: { per: 10 } },
            traits: ['Halberds', 'Elite'],
            tags: ['mob']
        })
    },
    {
        kind: 'creature', name: 'Rat Ogor', spec: skaven({
            hp: 70, ac: 14, size: 'large', movementSpeed: 40, cr: 5, xpValue: 1800, band: 'Packmaster',
            stats: { str: 20, dex: 12, con: 16, int: 4, wis: 8, cha: 5 },
            attacksPerAction: 2,
            attacks: [{ name: 'tearing claws', attackBonus: 8, damage: '2d8+5', damageType: 'slashing', default: true }],
            abilities: [{ name: 'Rabid Fury', recharge: 6 }],
            traits: ['Warpstone-fed'],
            tags: ['rat ogor']
        })
    },
    {
        kind: 'creature', name: 'Plague Monks', spec: skaven({
            hp: 100, ac: 11, size: 'large', movementSpeed: 30, cr: 5, xpValue: 1800, band: 'Clanrat',
            stats: { str: 12, dex: 14, con: 14, int: 8, wis: 10, cha: 8 },
            unit: { models: 20, hpPerModel: 5, packed: true, attackBonus: 4, breakAt: 0.25, morale: 10, mobRule: { per: 10 } },
            immunities: ['poison'],
            traits: ['Frenzied', 'Book of Woes'],
            tags: ['mob', 'pestilens']
        })
    },
    {
        kind: 'creature', name: 'Warp Lightning Cannon', spec: skaven({
            hp: 60, ac: 14, size: 'large', movementSpeed: 10, cr: 6, xpValue: 2300, band: 'Warlock Engineer',
            stats: { str: 10, dex: 8, con: 14, int: 14, wis: 8, cha: 6 },
            attacks: [{ name: 'warp lightning blast', attackBonus: 7, damage: '6d6', damageType: 'force', default: true, ranged: true, part: 'cannon' }],
            parts: [
                { name: 'cannon', kind: 'system', hp: 40, maxHp: 40, breakAt: 20, note: 'Crippled: the blast is 3d6 and misfires on a double; broken: it detonates' },
                { name: 'crew', kind: 'other', hp: 20, maxHp: 20, note: 'Crippled: the cannon fires every other round; dead: it does not fire' }
            ],
            abilities: [{ name: 'Overcharge', recharge: 4, note: 'Double the dice; a double on the attack roll rolls Warp Lightning Miscast for the crew' }],
            traits: ['War machine'],
            tags: ['war machine', 'skryre']
        })
    },
    {
        kind: 'creature', name: 'Rival Grey Seer', spec: skaven({
            hp: 60, ac: 14, size: 'medium', movementSpeed: 30, cr: 7, xpValue: 2900, band: 'Grey Seer',
            stats: { str: 8, dex: 14, con: 10, int: 18, wis: 14, cha: 14 },
            attacks: [{ name: 'staff', attackBonus: 4, damage: '1d6+1', damageType: 'bludgeoning', default: true }],
            abilities: [{ name: 'Unbind', note: 'As combat_action cast_spell unbinderId' }],
            spells: seerSpells,
            traits: ['Scurry Away', 'Lore of Ruin', 'Schemer'],
            tags: ['seer', 'rival']
        })
    },

    // ── Tables ──
    {
        kind: 'roll_table', name: 'Warp Lightning Miscast', spec: {
            dice: '2d6', modifierPool: 'warpstone_taint', poolDivisor: 3,
            entries: [
                { min: 2, max: 5, text: 'The warp lightning fizzles: green sparks, a smell of burnt fur, nothing worse.' },
                { min: 6, max: 9, text: 'The warp lightning earths through the caster: 2d10 force (11 written; the GM may roll it) and the warpstone bites deeper.', apply: { writes: [{ op: 'adjust_hp', delta: -11 }, { op: 'adjust_pool', pool: 'warpstone_taint', delta: 2 }] } },
                { min: 10, max: 12, text: 'A Gnawhole opens under the caster\'s feet.', chain: 'Gnawhole' }
            ]
        }
    },
    {
        kind: 'roll_table', name: "Horned Rat's Judgement", spec: {
            dice: '1d20',
            entries: [
                { min: 1, max: 1, text: 'Devoured: the Great Horned One takes the Seer whole. Nothing is left but a scorched circle.', apply: { terminal: 'kill', corpse: false } },
                { min: 2, max: 5, text: 'Marked: the Horned Rat\'s eye lingers and the warpstone in the Seer\'s blood answers it.', apply: { condition: { name: 'Marked by the Horned Rat', source: "Horned Rat's Judgement" }, writes: [{ op: 'adjust_pool', pool: 'warpstone_taint', delta: 3 }] } },
                { min: 6, max: 10, text: 'Indifference: the Great Horned One has other Seers to watch today.' },
                { min: 11, max: 15, text: 'Verminous Cunning: the Seer sees the scheme behind the scheme.', apply: { gift: { name: 'Verminous Cunning', description: '+2 on Insight and Deception', category: 'boon', powerLevel: 1, mechanics: [{ type: 'skill_bonus', value: 2, skill: 'Insight', autoApply: true }, { type: 'skill_bonus', value: 2, skill: 'Deception', autoApply: true }] } } },
                { min: 16, max: 19, text: 'The Horned Rat\'s Gaze: the Seer is favoured, and every rat in the burrow knows it.', apply: { gift: { name: "Horned Rat's Gaze", description: '+1 AC: lesser Skaven flinch from the Seer', category: 'boon', powerLevel: 2, mechanics: [{ type: 'ac_bonus', value: 1, autoApply: true }] }, writes: [{ op: 'adjust_pool', pool: 'horned_rat_favour', delta: 3 }] } },
                { min: 20, max: 20, text: 'Chosen: thirteen Verminlords turn their heads at once.', apply: { gift: { name: 'Chosen of the Horned Rat', description: 'Advantage on casting rolls at the GM\'s call; the Ascension track moves', category: 'transformative', powerLevel: 3, mechanics: [] }, writes: [{ op: 'adjust_pool', pool: 'horned_rat_favour', delta: 10 }] } }
            ]
        }
    },
    {
        kind: 'roll_table', name: 'Mutation', spec: {
            dice: '1d6',
            entries: [
                { min: 1, max: 1, text: 'An extra tail, prehensile and quick.', apply: { gift: { name: 'Extra Tail', description: 'A third hand for a dagger or a shard', category: 'transformative', powerLevel: 1, mechanics: [] } } },
                { min: 2, max: 2, text: 'Warpstone eyes: they see in the dark and glow when the Seer lies.', apply: { condition: { name: 'Warpstone Eyes', source: 'Mutation', pinned: true } } },
                { min: 3, max: 3, text: 'Chitin: plates of black-green shell push through the fur.', apply: { gift: { name: 'Chitin', description: '+1 AC', category: 'transformative', powerLevel: 1, mechanics: [{ type: 'ac_bonus', value: 1, autoApply: true }] } } },
                { min: 4, max: 4, text: 'A hand withers to a claw and will not hold a staff again.', apply: { condition: { name: 'Crippled Hand', source: 'Mutation', pinned: true } } },
                { min: 5, max: 5, text: 'The hunger: the Seer must eat warpstone or shake.', apply: { condition: { name: 'Warpstone Hunger', source: 'Mutation' }, writes: [{ op: 'adjust_pool', pool: 'warpstone_taint', delta: 1 }] } },
                { min: 6, max: 6, text: 'The change goes deeper than fur, and the Horned Rat notices.', chain: "Horned Rat's Judgement" }
            ]
        }
    },
    {
        kind: 'roll_table', name: 'Gnawhole', spec: {
            dice: '1d6',
            entries: [
                { min: 1, max: 2, text: 'The Gnawhole swallows the caster and spits them out somewhere else, bruised.', apply: { condition: { name: 'Displaced', duration: 1, source: 'Gnawhole' }, writes: [{ op: 'adjust_hp', delta: -5 }] } },
                { min: 3, max: 4, text: 'Something comes out of it: a Clanrat tide, or worse, that owes nobody loyalty (GM spawns it).' },
                { min: 5, max: 6, text: 'The Gnawhole closes with a hiss. The realmstone it ate is gone.' }
            ]
        }
    },

    // ── The Lore of Ruin: 2d6 casting against the Age of Sigmar casting value ──
    {
        kind: 'spell', name: 'Warp Lightning', spec: {
            castingRoll: { dice: '2d6', ability: 'int', target: 5 }, contestedBy: 'unbind', range: 60,
            effects: [{ type: 'damage', dice: '2d6', damageType: 'force' }],
            miscast: MISCAST
        }
    },
    {
        kind: 'spell', name: 'Warp Lightning (warpstone)', spec: {
            displayName: 'Warp Lightning (warpstone)',
            castingRoll: { dice: '2d6', ability: 'int', modifier: 2, target: 5 }, contestedBy: 'unbind', range: 60,
            cost: [{ pool: 'warpstone', delta: -1 }, { pool: 'warpstone_taint', delta: 1 }],
            effects: [{ type: 'damage', dice: '3d6', damageType: 'force' }],
            miscast: MISCAST
        }
    },
    {
        kind: 'spell', name: 'Skitterleap', spec: {
            castingRoll: { dice: '2d6', ability: 'int', target: 6 }, contestedBy: 'unbind', range: 30,
            effects: [{ type: 'condition', condition: 'Skitterleaped', duration: 1 }],
            miscast: MISCAST
        }
    },
    {
        kind: 'spell', name: 'Wither', spec: {
            castingRoll: { dice: '2d6', ability: 'int', target: 6 }, contestedBy: 'unbind', range: 60,
            effects: [{ type: 'condition', condition: 'Withered', duration: 3, save: { ability: 'con' } }],
            miscast: MISCAST
        }
    },
    {
        kind: 'spell', name: 'Death Frenzy', spec: {
            castingRoll: { dice: '2d6', ability: 'int', target: 7 }, contestedBy: 'unbind', range: 60,
            effects: [{ type: 'condition', condition: 'Death Frenzy', duration: 3 }],
            miscast: MISCAST
        }
    },
    {
        kind: 'spell', name: 'Plague', spec: {
            castingRoll: { dice: '2d6', ability: 'int', target: 7 }, contestedBy: 'unbind', range: 60,
            effects: [
                { type: 'damage', dice: '2d6', damageType: 'poison', save: { ability: 'con' }, saveEffect: 'half' },
                { type: 'condition', condition: 'Plagued', duration: 3, save: { ability: 'con' } }
            ],
            miscast: MISCAST
        }
    },
    {
        kind: 'spell', name: 'Curse of the Horned Rat', spec: {
            castingRoll: { dice: '2d6', ability: 'int', target: 8 }, contestedBy: 'unbind', range: 60,
            effects: [{ type: 'condition', condition: 'Cursed by the Horned Rat', duration: 3, save: { ability: 'wis' } }],
            miscast: MISCAST
        }
    },
    {
        kind: 'spell', name: 'Dreaded Thirteenth Spell', spec: {
            castingRoll: { dice: '2d6', ability: 'int', target: 8 }, contestedBy: 'unbind', range: 60,
            effects: [{ type: 'damage', dice: '6d6', damageType: 'force', save: { ability: 'con' }, saveEffect: 'half' }],
            miscast: MISCAST
        }
    },
    {
        kind: 'spell', name: 'Dreaded Thirteenth Spell (warpstone)', spec: {
            displayName: 'Dreaded Thirteenth Spell (warpstone)',
            castingRoll: { dice: '2d6', ability: 'int', modifier: 2, target: 8 }, contestedBy: 'unbind', range: 60,
            cost: [{ pool: 'warpstone', delta: -1 }, { pool: 'warpstone_taint', delta: 1 }],
            effects: [{ type: 'damage', dice: '8d6', damageType: 'force', save: { ability: 'con' }, saveEffect: 'half' }],
            miscast: MISCAST
        }
    },

    ...principles.map(([name, text]) => ({ kind: 'principle' as const, name, spec: { text } })),
];
