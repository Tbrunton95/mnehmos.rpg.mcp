/**
 * D&D 5e SRD Creature Presets
 *
 * Provides pre-configured creature stat blocks for common monsters.
 * These reduce token overhead by ~90% compared to manual specification.
 *
 * Usage:
 *   getCreaturePreset('goblin') -> full stat block
 *   expandCreatureTemplate('goblin:archer') -> goblin with shortbow
 *
 * Template syntax: "creature" or "creature:variant"
 */

/**
 * Partial character data for presets - id, createdAt, updatedAt generated on use
 */
export interface CreaturePreset {
    name: string;
    stats: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
    hp: number;
    maxHp: number;
    ac: number;
    level: number;
    characterType: 'enemy' | 'npc';
    race?: string;
    characterClass?: string;

    // Combat modifiers
    resistances?: string[];
    vulnerabilities?: string[];
    immunities?: string[];

    // Default attack info (for reference - actual attacks go in items)
    defaultAttack?: {
        name: string;
        damage: string;  // e.g., "1d6+2"
        damageType: string;
        toHit?: number;
    };

    // Movement and size
    size?: 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan';
    speed?: number;

    // Skill bonuses
    perceptionBonus?: number;
    stealthBonus?: number;

    // Challenge rating (for XP calculation)
    cr?: number;
    xpValue?: number;

    // Multiattack: attacks one Attack action allows (from the Multiattack trait)
    attacksPerAction?: number;

    // Special traits description
    traits?: string[];
}

/**
 * Creature variant modifiers
 */
interface CreatureVariant {
    namePrefix?: string;
    nameSuffix?: string;
    hpModifier?: number;
    acModifier?: number;
    statModifiers?: Partial<{ str: number; dex: number; con: number; int: number; wis: number; cha: number }>;
    defaultAttack?: CreaturePreset['defaultAttack'];
    equipment?: string[];  // Item preset names to equip
}

// ═══════════════════════════════════════════════════════════════════════════
// BASE CREATURE PRESETS - D&D 5e SRD
// ═══════════════════════════════════════════════════════════════════════════

export const CREATURE_PRESETS: Record<string, CreaturePreset> = {
    // ═══════════════ ZONE BESTIARY (Escape from Pripyat patch) ═══════════════
    psy_dog: {
        name: 'Psy Dog', stats: { str: 13, dex: 15, con: 12, int: 6, wis: 14, cha: 8 },
        hp: 20, maxHp: 20, ac: 13, level: 3, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 45,
        perceptionBonus: 5, stealthBonus: 4, cr: 1.5, xpValue: 300,
        defaultAttack: { name: 'Bite', damage: '2d4+2', damageType: 'piercing', toHit: 5 },
        traits: ['Phantom Pack: projects 2-3 illusory copies — attacks vs phantoms waste the action; kill the real one', 'Phantoms deal real fear, no damage']
    },
    karlik: {
        name: 'Karlik', stats: { str: 8, dex: 13, con: 12, int: 10, wis: 11, cha: 6 },
        hp: 16, maxHp: 16, ac: 13, level: 3, characterType: 'enemy', race: 'Mutant', size: 'small', speed: 30,
        perceptionBonus: 3, stealthBonus: 5, cr: 1, xpValue: 200,
        defaultAttack: { name: 'Kinetic Shove', damage: '1d8+2', damageType: 'bludgeoning', toHit: 4 },
        traits: ['ALWAYS spawns in packs of 3-5', 'Pack telekinesis: two karliks focusing one target knock it prone, STR 13 negates']
    },
    lurker: {
        name: 'Lurker', stats: { str: 12, dex: 14, con: 11, int: 5, wis: 12, cha: 4 },
        hp: 13, maxHp: 13, ac: 12, level: 2, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 40,
        perceptionBonus: 3, stealthBonus: 6, cr: 0.5, xpValue: 100,
        defaultAttack: { name: 'Raking Claws', damage: '1d6+2', damageType: 'slashing', toHit: 4 },
        traits: ['Squad hunter: bigger squads in the north, smaller south', 'Ambushes from ruins; retreats when isolated', 'Tail is a crafting drop']
    },
    fracture: {
        name: 'Fracture', stats: { str: 16, dex: 9, con: 15, int: 4, wis: 8, cha: 3 },
        hp: 28, maxHp: 28, ac: 13, level: 3, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 30,
        perceptionBonus: 1, stealthBonus: 1, cr: 1.5, xpValue: 300,
        defaultAttack: { name: 'Deformed Limbs', damage: '2d6+3', damageType: 'bludgeoning', toHit: 5 },
        traits: ['Ex-human, wrongly rebuilt — the joints bend the other way', 'Can spawn in packs', 'Relentless melee; no ranged answer']
    },
    psysucker: {
        name: 'Psysucker', stats: { str: 16, dex: 16, con: 14, int: 9, wis: 14, cha: 8 },
        hp: 40, maxHp: 40, ac: 14, level: 4, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 40,
        perceptionBonus: 5, stealthBonus: 7, cr: 3, xpValue: 700,
        defaultAttack: { name: 'Claws', damage: '2d6+2', damageType: 'slashing', toHit: 6 },
        traits: ['Bloodsucker variant: Cloak + first strike advantage', 'Psi Lash: instead of claws, 2d4 psychic at 30ft + psi exposure', 'Feeds on the mind mid-grapple — Composure drain, not blood']
    },
    renegade: {
        name: 'Renegade', stats: { str: 10, dex: 11, con: 10, int: 8, wis: 8, cha: 7 },
        hp: 9, maxHp: 9, ac: 11, level: 1, characterType: 'enemy', race: 'Human', size: 'medium', speed: 30,
        perceptionBonus: 0, stealthBonus: 1, cr: 0.125, xpValue: 25,
        defaultAttack: { name: 'Makarov PM', damage: '1d6', damageType: 'piercing', toHit: 2 },
        traits: ['Fringe scum: breaks and runs at half HP', 'Hated by everyone including bandits']
    },
    sin_cultist: {
        name: 'Sin Cultist', stats: { str: 14, dex: 12, con: 14, int: 8, wis: 13, cha: 10 },
        hp: 14, maxHp: 14, ac: 12, level: 2, characterType: 'enemy', race: 'Human', size: 'medium', speed: 30,
        perceptionBonus: 2, stealthBonus: 3, cr: 0.5, xpValue: 100,
        immunities: [],
        defaultAttack: { name: 'Rusted Blade', damage: '1d6+2', damageType: 'slashing', toHit: 4 },
        traits: ['Fights to the death: never morale-breaks', 'Psi-touched: immune to FRIGHTENED', 'Does not loot the dead — takes them']
    },
    unisg_operator: {
        name: 'UNISG Operator', stats: { str: 13, dex: 14, con: 13, int: 12, wis: 13, cha: 10 },
        hp: 24, maxHp: 24, ac: 14, level: 3, characterType: 'enemy', race: 'Human', size: 'medium', speed: 30,
        perceptionBonus: 4, stealthBonus: 4, cr: 1.5, xpValue: 300,
        defaultAttack: { name: 'Suppressed 5.56 Carbine', damage: '1d10', damageType: 'piercing', toHit: 5 },
        traits: ['Squad discipline: advantage when 2+ operators within 10ft', 'NVG: ignores DARKNESS', 'Shots at TALK volume (suppressed)', 'Does not exist officially']
    },
    blind_dog: {
        name: 'Blind Dog', stats: { str: 10, dex: 14, con: 10, int: 3, wis: 12, cha: 5 },
        hp: 6, maxHp: 6, ac: 12, level: 1, characterType: 'enemy', race: 'Mutant', size: 'small', speed: 40,
        perceptionBonus: 4, stealthBonus: 3, cr: 0.125, xpValue: 25,
        defaultAttack: { name: 'Bite', damage: '1d4+1', damageType: 'piercing', toHit: 3 },
        traits: ['Pack Tactics: advantage when packmate within 5ft', 'Pack Break: flees when pack takes 50% losses']
    },
    pseudodog: {
        name: 'Pseudodog', stats: { str: 14, dex: 15, con: 13, int: 5, wis: 13, cha: 7 },
        hp: 22, maxHp: 22, ac: 13, level: 2, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 45,
        perceptionBonus: 5, stealthBonus: 4, cr: 0.5, xpValue: 100,
        defaultAttack: { name: 'Bite', damage: '2d4+2', damageType: 'piercing', toHit: 4 },
        traits: ['Phantom Doubles: first attack against it each fight has disadvantage (which one is real)']
    },
    flesh: {
        name: 'Flesh', stats: { str: 13, dex: 9, con: 13, int: 2, wis: 10, cha: 3 },
        hp: 15, maxHp: 15, ac: 12, level: 1, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 30,
        perceptionBonus: 2, stealthBonus: 0, cr: 0.25, xpValue: 50,
        defaultAttack: { name: 'Gore', damage: '1d6+1', damageType: 'piercing', toHit: 3 },
        traits: ['Skittish: attacks only if cornered or in numbers', 'Human eyes track you']
    },
    zone_boar: {
        name: 'Boar', stats: { str: 15, dex: 10, con: 14, int: 2, wis: 9, cha: 4 },
        hp: 20, maxHp: 20, ac: 12, level: 2, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 35,
        perceptionBonus: 1, stealthBonus: 0, cr: 0.5, xpValue: 100,
        defaultAttack: { name: 'Charge', damage: '2d4+2', damageType: 'bludgeoning', toHit: 4 },
        traits: ['Relentless Charge: +1d4 damage after moving 15ft straight']
    },
    tushkano: {
        name: 'Tushkano', stats: { str: 4, dex: 15, con: 8, int: 2, wis: 10, cha: 3 },
        hp: 3, maxHp: 3, ac: 13, level: 1, characterType: 'enemy', race: 'Mutant', size: 'tiny', speed: 40,
        perceptionBonus: 2, stealthBonus: 5, cr: 0.125, xpValue: 10,
        defaultAttack: { name: 'Bite', damage: '1d3', damageType: 'piercing', toHit: 3 },
        traits: ['Swarm: they come in dozens']
    },
    snork: {
        name: 'Snork', stats: { str: 14, dex: 16, con: 13, int: 5, wis: 11, cha: 4 },
        hp: 18, maxHp: 18, ac: 13, level: 2, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 40,
        perceptionBonus: 3, stealthBonus: 5, cr: 0.5, xpValue: 100,
        defaultAttack: { name: 'Leaping Claws', damage: '2d4+2', damageType: 'slashing', toHit: 4 },
        traits: ['Leap: 15ft jump; attacks from above at advantage', 'Dog tags still legible on the corpse']
    },
    zombified_stalker: {
        name: 'Zombified Stalker', stats: { str: 12, dex: 7, con: 14, int: 4, wis: 5, cha: 3 },
        hp: 16, maxHp: 16, ac: 11, level: 2, characterType: 'enemy', race: 'Zombified', size: 'medium', speed: 20,
        perceptionBonus: 0, stealthBonus: 0, cr: 0.5, xpValue: 100,
        defaultAttack: { name: 'Rifle Burst', damage: '1d8', damageType: 'piercing', toHit: 2 },
        traits: ['Undying: only stops for the head (02 §4)', 'Walks its old patrol route; keys the radio in a flat voice']
    },
    bloodsucker: {
        name: 'Bloodsucker', stats: { str: 17, dex: 16, con: 15, int: 7, wis: 13, cha: 6 },
        hp: 45, maxHp: 45, ac: 14, level: 4, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 40,
        perceptionBonus: 4, stealthBonus: 7, cr: 3, xpValue: 700,
        defaultAttack: { name: 'Claws', damage: '2d6+3', damageType: 'slashing', toHit: 6 },
        traits: ['Cloak: unseen until it attacks; first strike at advantage', 'Feed: grappled target drained 2d4/turn', 'Caches kills; drinks over days (02 §4)']
    },
    burer: {
        name: 'Burer', stats: { str: 10, dex: 8, con: 15, int: 12, wis: 12, cha: 6 },
        hp: 35, maxHp: 35, ac: 13, level: 3, characterType: 'enemy', race: 'Mutant', size: 'small', speed: 20,
        perceptionBonus: 3, stealthBonus: 2, cr: 2, xpValue: 450,
        defaultAttack: { name: 'Telekinetic Slam', damage: '2d6+2', damageType: 'bludgeoning', toHit: 5 },
        traits: ['Telekinetic Shield: reaction — ranged attacks vs it at disadvantage', 'Disarm: on a hit, DEX 13 or the weapon flies 15ft', 'Hoards']
    },
    poltergeist_entity: {
        name: 'Poltergeist', stats: { str: 1, dex: 16, con: 10, int: 8, wis: 12, cha: 10 },
        hp: 25, maxHp: 25, ac: 14, level: 3, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 40,
        perceptionBonus: 4, stealthBonus: 8, cr: 2, xpValue: 450,
        resistances: ['slashing', 'piercing'], vulnerabilities: ['lightning'],
        defaultAttack: { name: 'Hurled Object', damage: '1d8+2', damageType: 'bludgeoning', toHit: 5 },
        traits: ['Interiors only', 'A glowing distortion; the room attacks you']
    },
    pseudogiant: {
        name: 'Pseudogiant', stats: { str: 20, dex: 8, con: 18, int: 4, wis: 10, cha: 5 },
        hp: 85, maxHp: 85, ac: 16, level: 6, characterType: 'enemy', race: 'Mutant', size: 'large', speed: 30,
        perceptionBonus: 2, stealthBonus: 0, cr: 5, xpValue: 1800,
        defaultAttack: { name: 'Stomp', damage: '3d8+4', damageType: 'bludgeoning', toHit: 7 },
        traits: ['Seismic Stomp: all within 10ft DEX 13 or prone', 'Interiors collapse around it']
    },
    chimera: {
        name: 'Chimera', stats: { str: 18, dex: 17, con: 16, int: 6, wis: 14, cha: 7 },
        hp: 60, maxHp: 60, ac: 15, level: 5, characterType: 'enemy', race: 'Mutant', size: 'large', speed: 50,
        perceptionBonus: 6, stealthBonus: 6, cr: 4, xpValue: 1100,
        defaultAttack: { name: 'Twin Maws', damage: '2d6+3', damageType: 'piercing', toHit: 6 },
        traits: ['Two Hearts: must be dropped twice — runs the second death track (02 §4)', 'Night hunter; attacks camps']
    },
    controller: {
        name: 'Controller', stats: { str: 11, dex: 10, con: 14, int: 15, wis: 17, cha: 14 },
        hp: 40, maxHp: 40, ac: 12, level: 5, characterType: 'enemy', race: 'Mutant', size: 'medium', speed: 25,
        perceptionBonus: 6, stealthBonus: 2, cr: 4, xpValue: 1100,
        immunities: ['psychic'],
        defaultAttack: { name: 'Psi Lash', damage: '2d6', damageType: 'psychic', toHit: 5 },
        traits: ['Dominate: opposed WIS vs targets (02 §6); it converts, it does not kill', 'Commands zombified within 60ft', 'Psi aura: +psi exposure per round in 30ft']
    },
    zone_bandit: {
        name: 'Bandit', stats: { str: 11, dex: 12, con: 11, int: 9, wis: 9, cha: 10 },
        hp: 11, maxHp: 11, ac: 12, level: 1, characterType: 'enemy', race: 'Human', size: 'medium', speed: 30,
        perceptionBonus: 1, stealthBonus: 2, cr: 0.25, xpValue: 50,
        defaultAttack: { name: 'Makarov PM', damage: '1d6', damageType: 'piercing', toHit: 3 },
        traits: ['Toll logic: fights for money, runs from losses']
    },
    zone_bandit_boss: {
        name: 'Toll Boss', stats: { str: 13, dex: 12, con: 13, int: 11, wis: 10, cha: 13 },
        hp: 22, maxHp: 22, ac: 13, level: 2, characterType: 'enemy', race: 'Human', size: 'medium', speed: 30,
        perceptionBonus: 2, stealthBonus: 2, cr: 1, xpValue: 200,
        defaultAttack: { name: 'TOZ-34 Sawn-off', damage: '2d6', damageType: 'piercing', toHit: 4 },
        traits: ['Executes threats on his own clock', 'Boots first']
    },
    zone_merc: {
        name: 'Mercenary', stats: { str: 12, dex: 14, con: 12, int: 11, wis: 12, cha: 10 },
        hp: 20, maxHp: 20, ac: 13, level: 2, characterType: 'enemy', race: 'Human', size: 'medium', speed: 30,
        perceptionBonus: 3, stealthBonus: 4, cr: 1, xpValue: 200,
        defaultAttack: { name: 'Viper 5', damage: '1d8', damageType: 'piercing', toHit: 5 },
        traits: ['Contracts do not care who', 'Works in pairs; one always overwatches']
    },
    monolith_fighter: {
        name: 'Monolith Fighter', stats: { str: 14, dex: 12, con: 14, int: 8, wis: 6, cha: 8 },
        hp: 25, maxHp: 25, ac: 14, level: 3, characterType: 'enemy', race: 'Human', size: 'medium', speed: 30,
        perceptionBonus: 2, stealthBonus: 2, cr: 1, xpValue: 200,
        immunities: ['psychic'],
        defaultAttack: { name: 'AKM-74/2', damage: '1d10', damageType: 'piercing', toHit: 5 },
        traits: ['Fearless: never morale-breaks, never retreats', 'The Crystal speaks; he listens']
    },

    // ─────────────────────────────────────────────────────────────────────────
    // HUMANOIDS - Low CR
    // ─────────────────────────────────────────────────────────────────────────
    goblin: {
        name: 'Goblin',
        stats: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
        hp: 7,
        maxHp: 7,
        ac: 15, // Leather armor + shield
        level: 1,
        characterType: 'enemy',
        race: 'Goblin',
        size: 'small',
        speed: 30,
        stealthBonus: 6,
        cr: 0.25,
        xpValue: 50,
        defaultAttack: {
            name: 'Scimitar',
            damage: '1d6+2',
            damageType: 'slashing',
            toHit: 4
        },
        traits: ['Nimble Escape: Disengage or Hide as bonus action']
    },

    hobgoblin: {
        name: 'Hobgoblin',
        stats: { str: 13, dex: 12, con: 12, int: 10, wis: 10, cha: 9 },
        hp: 11,
        maxHp: 11,
        ac: 18, // Chain mail + shield
        level: 1,
        characterType: 'enemy',
        race: 'Hobgoblin',
        size: 'medium',
        speed: 30,
        cr: 0.5,
        xpValue: 100,
        defaultAttack: {
            name: 'Longsword',
            damage: '1d8+1',
            damageType: 'slashing',
            toHit: 3
        },
        traits: ['Martial Advantage: Extra 2d6 damage once per turn if ally is within 5 ft of target']
    },

    bugbear: {
        name: 'Bugbear',
        stats: { str: 15, dex: 14, con: 13, int: 8, wis: 11, cha: 9 },
        hp: 27,
        maxHp: 27,
        ac: 16, // Hide armor + shield
        level: 3,
        characterType: 'enemy',
        race: 'Bugbear',
        size: 'medium',
        speed: 30,
        stealthBonus: 6,
        perceptionBonus: 2,
        cr: 1,
        xpValue: 200,
        defaultAttack: {
            name: 'Morningstar',
            damage: '2d8+2',
            damageType: 'piercing',
            toHit: 4
        },
        traits: ['Surprise Attack: Extra 2d6 damage if creature is surprised', 'Brute: Extra damage die on melee hits']
    },

    orc: {
        name: 'Orc',
        stats: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 },
        hp: 15,
        maxHp: 15,
        ac: 13, // Hide armor
        level: 1,
        characterType: 'enemy',
        race: 'Orc',
        size: 'medium',
        speed: 30,
        cr: 0.5,
        xpValue: 100,
        defaultAttack: {
            name: 'Greataxe',
            damage: '1d12+3',
            damageType: 'slashing',
            toHit: 5
        },
        traits: ['Aggressive: Bonus action to move up to speed toward hostile creature']
    },

    bandit: {
        name: 'Bandit',
        stats: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
        hp: 11,
        maxHp: 11,
        ac: 12, // Leather armor
        level: 1,
        characterType: 'enemy',
        race: 'Human',
        characterClass: 'rogue',
        size: 'medium',
        speed: 30,
        cr: 0.125,
        xpValue: 25,
        defaultAttack: {
            name: 'Scimitar',
            damage: '1d6+1',
            damageType: 'slashing',
            toHit: 3
        }
    },

    bandit_captain: {
        name: 'Bandit Captain',
        stats: { str: 15, dex: 16, con: 14, int: 14, wis: 11, cha: 14 },
        hp: 65,
        maxHp: 65,
        ac: 15, // Studded leather
        level: 5,
        characterType: 'enemy',
        race: 'Human',
        characterClass: 'fighter',
        size: 'medium',
        speed: 30,
        cr: 2,
        xpValue: 450,
        defaultAttack: {
            name: 'Scimitar',
            damage: '1d6+3',
            damageType: 'slashing',
            toHit: 5
        },
        attacksPerAction: 3,
        traits: ['Multiattack: Three melee attacks or two ranged']
    },

    thug: {
        name: 'Thug',
        stats: { str: 15, dex: 11, con: 14, int: 10, wis: 10, cha: 11 },
        hp: 32,
        maxHp: 32,
        ac: 11, // Leather armor
        level: 2,
        characterType: 'enemy',
        race: 'Human',
        size: 'medium',
        speed: 30,
        cr: 0.5,
        xpValue: 100,
        defaultAttack: {
            name: 'Mace',
            damage: '1d6+2',
            damageType: 'bludgeoning',
            toHit: 4
        },
        traits: ['Pack Tactics: Advantage when ally is within 5 ft of target']
    },

    cultist: {
        name: 'Cultist',
        stats: { str: 11, dex: 12, con: 10, int: 10, wis: 11, cha: 10 },
        hp: 9,
        maxHp: 9,
        ac: 12, // Leather armor
        level: 1,
        characterType: 'enemy',
        race: 'Human',
        size: 'medium',
        speed: 30,
        cr: 0.125,
        xpValue: 25,
        defaultAttack: {
            name: 'Scimitar',
            damage: '1d6+1',
            damageType: 'slashing',
            toHit: 3
        },
        traits: ['Dark Devotion: Advantage on saves vs charmed/frightened']
    },

    // ─────────────────────────────────────────────────────────────────────────
    // UNDEAD
    // ─────────────────────────────────────────────────────────────────────────
    skeleton: {
        name: 'Skeleton',
        stats: { str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5 },
        hp: 13,
        maxHp: 13,
        ac: 13, // Armor scraps
        level: 1,
        characterType: 'enemy',
        race: 'Undead',
        size: 'medium',
        speed: 30,
        vulnerabilities: ['bludgeoning'],
        immunities: ['poison'],
        cr: 0.25,
        xpValue: 50,
        defaultAttack: {
            name: 'Shortsword',
            damage: '1d6+2',
            damageType: 'piercing',
            toHit: 4
        }
    },

    zombie: {
        name: 'Zombie',
        stats: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
        hp: 22,
        maxHp: 22,
        ac: 8,
        level: 1,
        characterType: 'enemy',
        race: 'Undead',
        size: 'medium',
        speed: 20,
        immunities: ['poison'],
        cr: 0.25,
        xpValue: 50,
        defaultAttack: {
            name: 'Slam',
            damage: '1d6+1',
            damageType: 'bludgeoning',
            toHit: 3
        },
        traits: ['Undead Fortitude: DC 5 + damage CON save to stay at 1 HP instead of 0']
    },

    ghoul: {
        name: 'Ghoul',
        stats: { str: 13, dex: 15, con: 10, int: 7, wis: 10, cha: 6 },
        hp: 22,
        maxHp: 22,
        ac: 12,
        level: 2,
        characterType: 'enemy',
        race: 'Undead',
        size: 'medium',
        speed: 30,
        immunities: ['poison'],
        cr: 1,
        xpValue: 200,
        defaultAttack: {
            name: 'Claws',
            damage: '2d4+2',
            damageType: 'slashing',
            toHit: 4
        },
        traits: ['Paralyzing Touch: DC 10 CON save or paralyzed for 1 minute']
    },

    wight: {
        name: 'Wight',
        stats: { str: 15, dex: 14, con: 16, int: 10, wis: 13, cha: 15 },
        hp: 45,
        maxHp: 45,
        ac: 14, // Studded leather
        level: 4,
        characterType: 'enemy',
        race: 'Undead',
        size: 'medium',
        speed: 30,
        resistances: ['necrotic', 'nonmagical bludgeoning/piercing/slashing'],
        immunities: ['poison'],
        cr: 3,
        xpValue: 700,
        defaultAttack: {
            name: 'Longsword',
            damage: '1d8+2',
            damageType: 'slashing',
            toHit: 4
        },
        traits: ['Life Drain: Necrotic attack reduces max HP', 'Sunlight Sensitivity: Disadvantage in sunlight']
    },

    // ─────────────────────────────────────────────────────────────────────────
    // BEASTS
    // ─────────────────────────────────────────────────────────────────────────
    wolf: {
        name: 'Wolf',
        stats: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
        hp: 11,
        maxHp: 11,
        ac: 13, // Natural armor
        level: 1,
        characterType: 'enemy',
        race: 'Beast',
        size: 'medium',
        speed: 40,
        perceptionBonus: 3,
        stealthBonus: 4,
        cr: 0.25,
        xpValue: 50,
        defaultAttack: {
            name: 'Bite',
            damage: '2d4+2',
            damageType: 'piercing',
            toHit: 4
        },
        traits: ['Pack Tactics: Advantage when ally within 5 ft', 'Keen Hearing and Smell: Advantage on Perception']
    },

    dire_wolf: {
        name: 'Dire Wolf',
        stats: { str: 17, dex: 15, con: 15, int: 3, wis: 12, cha: 7 },
        hp: 37,
        maxHp: 37,
        ac: 14,
        level: 3,
        characterType: 'enemy',
        race: 'Beast',
        size: 'large',
        speed: 50,
        perceptionBonus: 3,
        stealthBonus: 4,
        cr: 1,
        xpValue: 200,
        defaultAttack: {
            name: 'Bite',
            damage: '2d6+3',
            damageType: 'piercing',
            toHit: 5
        },
        traits: ['Pack Tactics', 'Keen Hearing and Smell', 'Knockdown: DC 13 STR or prone']
    },

    giant_spider: {
        name: 'Giant Spider',
        stats: { str: 14, dex: 16, con: 12, int: 2, wis: 11, cha: 4 },
        hp: 26,
        maxHp: 26,
        ac: 14,
        level: 2,
        characterType: 'enemy',
        race: 'Beast',
        size: 'large',
        speed: 30,
        stealthBonus: 7,
        cr: 1,
        xpValue: 200,
        defaultAttack: {
            name: 'Bite',
            damage: '1d8+3',
            damageType: 'piercing',
            toHit: 5
        },
        traits: ['Spider Climb', 'Web Sense', 'Web Walker', 'Poison: DC 11 CON or 2d8 poison damage']
    },

    giant_rat: {
        name: 'Giant Rat',
        stats: { str: 7, dex: 15, con: 11, int: 2, wis: 10, cha: 4 },
        hp: 7,
        maxHp: 7,
        ac: 12,
        level: 1,
        characterType: 'enemy',
        race: 'Beast',
        size: 'small',
        speed: 30,
        cr: 0.125,
        xpValue: 25,
        defaultAttack: {
            name: 'Bite',
            damage: '1d4+2',
            damageType: 'piercing',
            toHit: 4
        },
        traits: ['Pack Tactics', 'Keen Smell']
    },

    bear_black: {
        name: 'Black Bear',
        stats: { str: 15, dex: 10, con: 14, int: 2, wis: 12, cha: 7 },
        hp: 19,
        maxHp: 19,
        ac: 11,
        level: 2,
        characterType: 'enemy',
        race: 'Beast',
        size: 'medium',
        speed: 40,
        perceptionBonus: 3,
        cr: 0.5,
        xpValue: 100,
        defaultAttack: {
            name: 'Claws',
            damage: '2d4+2',
            damageType: 'slashing',
            toHit: 4
        },
        attacksPerAction: 2,
        traits: ['Multiattack: Bite and claws', 'Keen Smell']
    },

    bear_brown: {
        name: 'Brown Bear',
        stats: { str: 19, dex: 10, con: 16, int: 2, wis: 13, cha: 7 },
        hp: 34,
        maxHp: 34,
        ac: 11,
        level: 3,
        characterType: 'enemy',
        race: 'Beast',
        size: 'large',
        speed: 40,
        perceptionBonus: 3,
        cr: 1,
        xpValue: 200,
        defaultAttack: {
            name: 'Claws',
            damage: '2d6+4',
            damageType: 'slashing',
            toHit: 6
        },
        attacksPerAction: 2,
        traits: ['Multiattack: Bite and claws', 'Keen Smell']
    },

    // ─────────────────────────────────────────────────────────────────────────
    // DRAGONS (Wyrmlings)
    // ─────────────────────────────────────────────────────────────────────────
    dragon_wyrmling_red: {
        name: 'Red Dragon Wyrmling',
        stats: { str: 19, dex: 10, con: 17, int: 12, wis: 11, cha: 15 },
        hp: 75,
        maxHp: 75,
        ac: 17,
        level: 6,
        characterType: 'enemy',
        race: 'Dragon',
        size: 'medium',
        speed: 30,
        immunities: ['fire'],
        perceptionBonus: 4,
        stealthBonus: 2,
        cr: 4,
        xpValue: 1100,
        defaultAttack: {
            name: 'Bite',
            damage: '1d10+4',
            damageType: 'piercing',
            toHit: 6
        },
        traits: ['Fire Breath: 15 ft cone, 7d6 fire, DC 13 DEX half']
    },

    dragon_wyrmling_white: {
        name: 'White Dragon Wyrmling',
        stats: { str: 14, dex: 10, con: 14, int: 5, wis: 10, cha: 11 },
        hp: 32,
        maxHp: 32,
        ac: 16,
        level: 4,
        characterType: 'enemy',
        race: 'Dragon',
        size: 'medium',
        speed: 30,
        immunities: ['cold'],
        perceptionBonus: 4,
        stealthBonus: 2,
        cr: 2,
        xpValue: 450,
        defaultAttack: {
            name: 'Bite',
            damage: '1d10+2',
            damageType: 'piercing',
            toHit: 4
        },
        traits: ['Cold Breath: 15 ft cone, 5d8 cold, DC 12 CON half']
    },

    // ─────────────────────────────────────────────────────────────────────────
    // CONSTRUCTS
    // ─────────────────────────────────────────────────────────────────────────
    animated_armor: {
        name: 'Animated Armor',
        stats: { str: 14, dex: 11, con: 13, int: 1, wis: 3, cha: 1 },
        hp: 33,
        maxHp: 33,
        ac: 18, // Natural armor
        level: 3,
        characterType: 'enemy',
        race: 'Construct',
        size: 'medium',
        speed: 25,
        immunities: ['poison', 'psychic'],
        cr: 1,
        xpValue: 200,
        defaultAttack: {
            name: 'Slam',
            damage: '1d6+2',
            damageType: 'bludgeoning',
            toHit: 4
        },
        traits: ['Antimagic Susceptibility: Incapacitated in antimagic', 'False Appearance: Looks like normal armor']
    },

    flying_sword: {
        name: 'Flying Sword',
        stats: { str: 12, dex: 15, con: 11, int: 1, wis: 5, cha: 1 },
        hp: 17,
        maxHp: 17,
        ac: 17, // Natural armor
        level: 1,
        characterType: 'enemy',
        race: 'Construct',
        size: 'small',
        speed: 50,
        immunities: ['poison', 'psychic'],
        cr: 0.25,
        xpValue: 50,
        defaultAttack: {
            name: 'Longsword',
            damage: '1d8+1',
            damageType: 'slashing',
            toHit: 3
        },
        traits: ['Antimagic Susceptibility', 'False Appearance']
    },

    // ─────────────────────────────────────────────────────────────────────────
    // MONSTROSITIES
    // ─────────────────────────────────────────────────────────────────────────
    mimic: {
        name: 'Mimic',
        stats: { str: 17, dex: 12, con: 15, int: 5, wis: 13, cha: 8 },
        hp: 58,
        maxHp: 58,
        ac: 12,
        level: 4,
        characterType: 'enemy',
        race: 'Monstrosity',
        size: 'medium',
        speed: 15,
        immunities: ['acid'],
        stealthBonus: 5,
        cr: 2,
        xpValue: 450,
        defaultAttack: {
            name: 'Pseudopod',
            damage: '1d8+3',
            damageType: 'bludgeoning',
            toHit: 5
        },
        traits: ['Shapechanger: Polymorph into object', 'Adhesive: Grapples on hit', 'False Appearance', 'Grappler']
    },

    owlbear: {
        name: 'Owlbear',
        stats: { str: 20, dex: 12, con: 17, int: 3, wis: 12, cha: 7 },
        hp: 59,
        maxHp: 59,
        ac: 13,
        level: 5,
        characterType: 'enemy',
        race: 'Monstrosity',
        size: 'large',
        speed: 40,
        perceptionBonus: 3,
        cr: 3,
        xpValue: 700,
        defaultAttack: {
            name: 'Claws',
            damage: '2d8+5',
            damageType: 'slashing',
            toHit: 7
        },
        attacksPerAction: 2,
        traits: ['Multiattack: Beak and claws', 'Keen Sight and Smell']
    },

    harpy: {
        name: 'Harpy',
        stats: { str: 12, dex: 13, con: 12, int: 7, wis: 10, cha: 13 },
        hp: 38,
        maxHp: 38,
        ac: 11,
        level: 3,
        characterType: 'enemy',
        race: 'Monstrosity',
        size: 'medium',
        speed: 20,
        cr: 1,
        xpValue: 200,
        defaultAttack: {
            name: 'Claws',
            damage: '2d4+1',
            damageType: 'slashing',
            toHit: 3
        },
        attacksPerAction: 2,
        traits: ['Multiattack: Claws and club', 'Luring Song: DC 11 WIS or charmed']
    },

    // ─────────────────────────────────────────────────────────────────────────
    // DEMONS & FIENDS
    // ─────────────────────────────────────────────────────────────────────────
    imp: {
        name: 'Imp',
        stats: { str: 6, dex: 17, con: 13, int: 11, wis: 12, cha: 14 },
        hp: 10,
        maxHp: 10,
        ac: 13,
        level: 2,
        characterType: 'enemy',
        race: 'Fiend',
        size: 'tiny',
        speed: 20,
        resistances: ['cold', 'nonmagical bludgeoning/piercing/slashing'],
        immunities: ['fire', 'poison'],
        stealthBonus: 5,
        cr: 1,
        xpValue: 200,
        defaultAttack: {
            name: 'Sting',
            damage: '1d4+3',
            damageType: 'piercing',
            toHit: 5
        },
        traits: ['Shapechanger', 'Devils Sight', 'Magic Resistance', 'Poison Sting: DC 11 CON or 3d6 poison']
    },

    quasit: {
        name: 'Quasit',
        stats: { str: 5, dex: 17, con: 10, int: 7, wis: 10, cha: 10 },
        hp: 7,
        maxHp: 7,
        ac: 13,
        level: 2,
        characterType: 'enemy',
        race: 'Fiend',
        size: 'tiny',
        speed: 40,
        resistances: ['cold', 'fire', 'lightning', 'nonmagical bludgeoning/piercing/slashing'],
        immunities: ['poison'],
        stealthBonus: 5,
        cr: 1,
        xpValue: 200,
        defaultAttack: {
            name: 'Claws',
            damage: '1d4+3',
            damageType: 'slashing',
            toHit: 5
        },
        traits: ['Shapechanger', 'Magic Resistance', 'Poison Claws: DC 10 CON or 2d4 poison']
    },

    // ─────────────────────────────────────────────────────────────────────────
    // GIANTS
    // ─────────────────────────────────────────────────────────────────────────
    ogre: {
        name: 'Ogre',
        stats: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
        hp: 59,
        maxHp: 59,
        ac: 11, // Hide armor
        level: 4,
        characterType: 'enemy',
        race: 'Giant',
        size: 'large',
        speed: 40,
        cr: 2,
        xpValue: 450,
        defaultAttack: {
            name: 'Greatclub',
            damage: '2d8+4',
            damageType: 'bludgeoning',
            toHit: 6
        }
    },

    troll: {
        name: 'Troll',
        stats: { str: 18, dex: 13, con: 20, int: 7, wis: 9, cha: 7 },
        hp: 84,
        maxHp: 84,
        ac: 15,
        level: 6,
        characterType: 'enemy',
        race: 'Giant',
        size: 'large',
        speed: 30,
        perceptionBonus: 2,
        cr: 5,
        xpValue: 1800,
        defaultAttack: {
            name: 'Claws',
            damage: '2d6+4',
            damageType: 'slashing',
            toHit: 7
        },
        attacksPerAction: 3,
        traits: ['Multiattack: Bite and 2 claws', 'Regeneration: 10 HP per turn unless fire/acid damage', 'Keen Smell']
    },

    // ─────────────────────────────────────────────────────────────────────────
    // ELEMENTALS
    // ─────────────────────────────────────────────────────────────────────────
    fire_elemental: {
        name: 'Fire Elemental',
        stats: { str: 10, dex: 17, con: 16, int: 6, wis: 10, cha: 7 },
        hp: 102,
        maxHp: 102,
        ac: 13,
        level: 8,
        characterType: 'enemy',
        race: 'Elemental',
        size: 'large',
        speed: 50,
        resistances: ['nonmagical bludgeoning/piercing/slashing'],
        immunities: ['fire', 'poison'],
        cr: 5,
        xpValue: 1800,
        defaultAttack: {
            name: 'Touch',
            damage: '2d6+3',
            damageType: 'fire',
            toHit: 6
        },
        traits: ['Fire Form: Move through 1-inch spaces', 'Illumination: Bright light 30 ft', 'Water Susceptibility: 1 cold damage per gallon']
    },

    water_elemental: {
        name: 'Water Elemental',
        stats: { str: 18, dex: 14, con: 18, int: 5, wis: 10, cha: 8 },
        hp: 114,
        maxHp: 114,
        ac: 14,
        level: 8,
        characterType: 'enemy',
        race: 'Elemental',
        size: 'large',
        speed: 30,
        resistances: ['acid', 'nonmagical bludgeoning/piercing/slashing'],
        immunities: ['poison'],
        cr: 5,
        xpValue: 1800,
        defaultAttack: {
            name: 'Slam',
            damage: '2d8+4',
            damageType: 'bludgeoning',
            toHit: 7
        },
        traits: ['Water Form: Move through 1-inch spaces', 'Freeze: 1 cold damage freezes 1 ft', 'Whelm: Engulf and drown']
    },

    // ═══ FINDINGS #96-C: THE WITCHER ROSTER — nine quick-spawn taxa for the
    // Continent (drowner packs at last: spawn_quick_enemy {creature:'drowner',
    // count:4}). Silver-vulnerability rides the vulnerabilities column;
    // spectral insubstantiality is Law 5 (GM-side, Yrden lifts it). ═══
    drowner: {
        name: 'Drowner', stats: { str: 13, dex: 12, con: 12, int: 4, wis: 8, cha: 4 },
        hp: 11, maxHp: 11, ac: 12, level: 1, characterType: 'enemy', race: 'Necrophage', size: 'medium', speed: 30,
        cr: 0.5, xpValue: 100, vulnerabilities: ['silver'],
        defaultAttack: { name: 'Claws', damage: '1d6+1', damageType: 'slashing', toHit: 3 },
        traits: ['Amphibious', 'Pack hunter: advantage when an ally is adjacent to the target', 'Mud lurk: ambushes from water at Stealth +5']
    },
    nekker: {
        name: 'Nekker', stats: { str: 8, dex: 15, con: 10, int: 5, wis: 8, cha: 4 },
        hp: 7, maxHp: 7, ac: 13, level: 1, characterType: 'enemy', race: 'Ogroid', size: 'small', speed: 35,
        cr: 0.25, xpValue: 50, vulnerabilities: ['silver'],
        defaultAttack: { name: 'Bite', damage: '1d4+2', damageType: 'piercing', toHit: 4 },
        traits: ['Warren swarm: never alone — 1d4+2 more within 60ft', 'Burrow: emerges adjacent, Stealth +6', 'Craven: flees at half pack losses']
    },
    // ('ghoul' spawns the base D&D undead above — the Continent's ghoul-kin
    // ships as ALGHOUL, the canonical tougher cousin, to avoid the key clash.)
    alghoul: {
        name: 'Alghoul', stats: { str: 14, dex: 13, con: 13, int: 6, wis: 10, cha: 5 },
        hp: 16, maxHp: 16, ac: 13, level: 2, characterType: 'enemy', race: 'Necrophage', size: 'medium', speed: 35,
        cr: 1, xpValue: 200, vulnerabilities: ['silver'],
        defaultAttack: { name: 'Bite', damage: '1d8+2', damageType: 'piercing', toHit: 4 },
        traits: ['Carrion frenzy: +2 damage while any corpse lies within 30ft', 'Grave-fever: bite forces DC 11 CON or poisoned 1hr', 'Feeds mid-fight if a body drops']
    },
    rotfiend: {
        name: 'Rotfiend', stats: { str: 14, dex: 10, con: 14, int: 4, wis: 8, cha: 4 },
        hp: 22, maxHp: 22, ac: 11, level: 2, characterType: 'enemy', race: 'Necrophage', size: 'medium', speed: 30,
        cr: 1, xpValue: 200, vulnerabilities: ['silver'],
        defaultAttack: { name: 'Rake', damage: '1d8+2', damageType: 'slashing', toHit: 4 },
        traits: ['DEATH BURST: at 0 HP explodes — 2d6 acid, 10ft, DC 12 DEX half; the corpse is DESTROYED (no harvest)', 'Stench: DC 10 CON within 5ft or disadvantage 1 round']
    },
    grave_hag: {
        name: 'Grave Hag', stats: { str: 15, dex: 14, con: 14, int: 9, wis: 12, cha: 7 },
        hp: 45, maxHp: 45, ac: 14, level: 4, characterType: 'enemy', race: 'Necrophage', size: 'medium', speed: 35,
        cr: 3, xpValue: 700, vulnerabilities: ['silver'],
        defaultAttack: { name: 'Prehensile tongue', damage: '2d6+2', damageType: 'bludgeoning', toHit: 5 },
        traits: ['Tongue lash: 15ft reach, hit pulls the target 10ft closer', 'Bone-yard speed: ignores difficult terrain among graves', 'Regenerates 3/round unless silver wounded this round']
    },
    noonwraith: {
        name: 'Noonwraith', stats: { str: 6, dex: 16, con: 10, int: 8, wis: 12, cha: 14 },
        hp: 30, maxHp: 30, ac: 14, level: 4, characterType: 'enemy', race: 'Specter', size: 'medium', speed: 40,
        cr: 3, xpValue: 700, vulnerabilities: ['silver'], resistances: ['bludgeoning', 'piercing', 'slashing'],
        immunities: ['poison'],
        defaultAttack: { name: 'Spectral scythe', damage: '2d8', damageType: 'necrotic', toHit: 6 },
        traits: ['INSUBSTANTIAL (Law 5): attacks vs her at disadvantage, half damage — LIFTED inside Yrden or once her anchor is named', 'Noon fury: advantage on everything in direct sun', 'Blur step: 20ft teleport as bonus action', 'ANCHORED: cannot leave 300ft of her tether; the anchor is always a story']
    },
    werewolf: {
        name: 'Werewolf', stats: { str: 17, dex: 15, con: 16, int: 10, wis: 11, cha: 10 },
        hp: 58, maxHp: 58, ac: 14, level: 5, characterType: 'enemy', race: 'Cursed One', size: 'medium', speed: 40,
        cr: 4, xpValue: 1100, vulnerabilities: ['silver'], resistances: ['bludgeoning', 'piercing', 'slashing'],
        defaultAttack: { name: 'Claws', damage: '2d6+3', damageType: 'slashing', toHit: 6 },
        traits: ['Regenerates 5/round unless silver wounded this round', 'Frenzy below half HP: extra claw attack, −2 AC', 'A PERSON is inside — the curse is a secret row; killing it is one resolution and rarely the paid one']
    },
    forktail: {
        name: 'Forktail', stats: { str: 18, dex: 13, con: 16, int: 5, wis: 11, cha: 7 },
        hp: 68, maxHp: 68, ac: 15, level: 6, characterType: 'enemy', race: 'Draconid', size: 'large', speed: 30,
        cr: 5, xpValue: 1800,
        defaultAttack: { name: 'Tail scythe', damage: '2d8+4', damageType: 'slashing', toHit: 7 },
        traits: ['FLIGHT 60ft — strafes, does not brawl; grounding it is the fight', 'Tail sweep: hits two adjacent targets', 'Dive: +1d8 after moving 30ft airborne', 'Hide too thick for arrows: ranged disadvantage beyond 30ft']
    },
    leshen: {
        name: 'Leshen', stats: { str: 18, dex: 12, con: 18, int: 14, wis: 16, cha: 14 },
        hp: 105, maxHp: 105, ac: 16, level: 8, characterType: 'enemy', race: 'Relict', size: 'large', speed: 30,
        cr: 7, xpValue: 2900, vulnerabilities: ['fire'], resistances: ['bludgeoning', 'piercing'],
        immunities: ['poison', 'charm'],
        defaultAttack: { name: 'Root spears', damage: '2d10+4', damageType: 'piercing', toHit: 7 },
        traits: ['Root eruption: 20ft range, DC 14 DEX or restrained', 'Summons: 1d4 wolves or a crow murder each round it chooses', 'Marked territory: it knows where everything in its forest stands — no ambushing it at home', 'THE REGION\'S KETER: relicts do not negotiate and Axii does not touch them']
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// CREATURE VARIANTS
// ═══════════════════════════════════════════════════════════════════════════

export const CREATURE_VARIANTS: Record<string, Record<string, CreatureVariant>> = {
    goblin: {
        warrior: {
            nameSuffix: ' Warrior',
            hpModifier: 3,
            acModifier: 0,
            equipment: ['scimitar', 'shield']
        },
        archer: {
            nameSuffix: ' Archer',
            hpModifier: 0,
            acModifier: -2, // No shield
            defaultAttack: {
                name: 'Shortbow',
                damage: '1d6+2',
                damageType: 'piercing',
                toHit: 4
            },
            equipment: ['shortbow']
        },
        boss: {
            namePrefix: 'Goblin ',
            nameSuffix: ' Boss',
            hpModifier: 15,
            acModifier: 2,
            statModifiers: { str: 2, con: 2, cha: 4 },
            equipment: ['scimitar', 'shield']
        },
        shaman: {
            nameSuffix: ' Shaman',
            hpModifier: 5,
            acModifier: -3, // No armor
            statModifiers: { wis: 4, cha: 2 },
            equipment: ['quarterstaff']
        }
    },

    skeleton: {
        warrior: {
            nameSuffix: ' Warrior',
            hpModifier: 5,
            acModifier: 2,
            equipment: ['shortsword', 'shield']
        },
        archer: {
            nameSuffix: ' Archer',
            hpModifier: 0,
            defaultAttack: {
                name: 'Shortbow',
                damage: '1d6+2',
                damageType: 'piercing',
                toHit: 4
            },
            equipment: ['shortbow']
        },
        mage: {
            nameSuffix: ' Mage',
            hpModifier: 10,
            statModifiers: { int: 6, wis: 4 }
        }
    },

    orc: {
        warrior: {
            nameSuffix: ' Warrior',
            hpModifier: 5,
            equipment: ['greataxe']
        },
        berserker: {
            nameSuffix: ' Berserker',
            hpModifier: 10,
            acModifier: -2,
            statModifiers: { str: 2, con: 2 },
            equipment: ['greataxe']
        },
        warleader: {
            namePrefix: 'Orc ',
            nameSuffix: ' War Chief',
            hpModifier: 30,
            acModifier: 3,
            statModifiers: { str: 4, con: 4, cha: 4 },
            equipment: ['greataxe', 'chainmail']
        }
    },

    bandit: {
        thug: {
            nameSuffix: ' Thug',
            hpModifier: 10,
            statModifiers: { str: 2 },
            equipment: ['mace']
        },
        archer: {
            nameSuffix: ' Archer',
            hpModifier: 0,
            defaultAttack: {
                name: 'Light Crossbow',
                damage: '1d8+1',
                damageType: 'piercing',
                toHit: 3
            },
            equipment: ['light_crossbow']
        }
    },

    hobgoblin: {
        warrior: {
            nameSuffix: ' Warrior',
            hpModifier: 5,
            equipment: ['longsword', 'shield', 'chainmail']
        },
        captain: {
            namePrefix: 'Hobgoblin ',
            nameSuffix: ' Captain',
            hpModifier: 30,
            acModifier: 2,
            statModifiers: { str: 2, con: 2, cha: 4 },
            equipment: ['longsword', 'shield', 'chainmail']
        },
        archer: {
            nameSuffix: ' Archer',
            hpModifier: 0,
            acModifier: -4,
            defaultAttack: {
                name: 'Longbow',
                damage: '1d8+1',
                damageType: 'piercing',
                toHit: 3
            },
            equipment: ['longbow']
        }
    },

    zombie: {
        fast: {
            namePrefix: 'Fast ',
            hpModifier: -5,
            statModifiers: { dex: 6 }
        },
        brute: {
            nameSuffix: ' Brute',
            hpModifier: 15,
            acModifier: 2,
            statModifiers: { str: 4, con: 4 }
        }
    },

    wolf: {
        alpha: {
            namePrefix: 'Alpha ',
            hpModifier: 10,
            acModifier: 1,
            statModifiers: { str: 2, con: 2, cha: 4 }
        },
        dire: {
            namePrefix: 'Dire ',
            hpModifier: 26,
            acModifier: 1,
            statModifiers: { str: 5, con: 3 }
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a raw creature preset by name
 */
export function getCreaturePreset(name: string): CreaturePreset | null {
    const normalized = name.toLowerCase().replace(/[\s-]/g, '_');
    return CREATURE_PRESETS[normalized] || null;
}

/**
 * Parse a creature template string like "goblin:archer" or just "goblin"
 */
export function parseCreatureTemplate(template: string): { base: string; variant?: string } {
    const [base, variant] = template.toLowerCase().split(':');
    return { base: base.replace(/[\s-]/g, '_'), variant };
}

/**
 * Expand a creature template into a full preset with variant applied
 */
export function expandCreatureTemplate(template: string, nameOverride?: string): CreaturePreset | null {
    const { base, variant } = parseCreatureTemplate(template);
    const basePreset = getCreaturePreset(base);

    if (!basePreset) {
        return null;
    }

    // No variant - return base
    if (!variant) {
        if (nameOverride) {
            return { ...basePreset, name: nameOverride };
        }
        return { ...basePreset };
    }

    // Find variant
    const variantDef = CREATURE_VARIANTS[base]?.[variant];
    if (!variantDef) {
        // Variant not found, return base with warning in name
        console.warn(`Unknown variant "${variant}" for "${base}", using base preset`);
        if (nameOverride) {
            return { ...basePreset, name: nameOverride };
        }
        return { ...basePreset };
    }

    // Apply variant modifications
    const expanded: CreaturePreset = {
        ...basePreset,
        name: nameOverride || `${variantDef.namePrefix || ''}${basePreset.name}${variantDef.nameSuffix || ''}`,
        hp: basePreset.hp + (variantDef.hpModifier || 0),
        maxHp: basePreset.maxHp + (variantDef.hpModifier || 0),
        ac: basePreset.ac + (variantDef.acModifier || 0),
    };

    // Apply stat modifiers
    if (variantDef.statModifiers) {
        expanded.stats = {
            str: basePreset.stats.str + (variantDef.statModifiers.str || 0),
            dex: basePreset.stats.dex + (variantDef.statModifiers.dex || 0),
            con: basePreset.stats.con + (variantDef.statModifiers.con || 0),
            int: basePreset.stats.int + (variantDef.statModifiers.int || 0),
            wis: basePreset.stats.wis + (variantDef.statModifiers.wis || 0),
            cha: basePreset.stats.cha + (variantDef.statModifiers.cha || 0),
        };
    }

    // Override default attack if specified
    if (variantDef.defaultAttack) {
        expanded.defaultAttack = variantDef.defaultAttack;
    }

    return expanded;
}

/**
 * List all available creature presets
 */
export function listCreaturePresets(): string[] {
    return Object.keys(CREATURE_PRESETS);
}

/**
 * List all variants for a creature
 */
export function listCreatureVariants(creatureName: string): string[] {
    const normalized = creatureName.toLowerCase().replace(/[\s-]/g, '_');
    const variants = CREATURE_VARIANTS[normalized];
    return variants ? Object.keys(variants) : [];
}

/**
 * Get all available templates (base and variants) as strings
 */
export function listAllTemplates(): string[] {
    const templates: string[] = [];

    for (const base of Object.keys(CREATURE_PRESETS)) {
        templates.push(base);
        const variants = CREATURE_VARIANTS[base];
        if (variants) {
            for (const variant of Object.keys(variants)) {
                templates.push(`${base}:${variant}`);
            }
        }
    }

    return templates;
}
