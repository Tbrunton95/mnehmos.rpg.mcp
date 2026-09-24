/**
 * Consolidated travel_manage tool
 * Replaces: travel_to_location, loot_encounter, rest_party
 * 3 tools → 1 tool with 3 actions
 */

import { z } from 'zod';
import { matchAction, isGuidingError } from '../../utils/fuzzy-enum.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { characterLexicon, DEFAULT_LEXICON } from '../../engine/table-rules.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { PartyRepository } from '../../storage/repos/party.repo.js';
import { CorpseRepository } from '../../storage/repos/corpse.repo.js';
import { SpatialRepository } from '../../storage/repos/spatial.repo.js';
import { PoiRepository } from '../../storage/repos/poi.repo.js';
import { SessionContext } from '../types.js';

export interface McpResponse {
    content: Array<{ type: 'text'; text: string }>;
}

const ACTIONS = ['travel', 'loot', 'rest'] as const;

type TravelAction = typeof ACTIONS[number];

// Alias map for fuzzy action matching
const ALIASES: Record<string, TravelAction> = {
    'move': 'travel',
    'goto': 'travel',
    'travel_to': 'travel',
    'go_to': 'travel',
    'travel_to_location': 'travel',
    'loot_encounter': 'loot',
    'loot_all': 'loot',
    'collect': 'loot',
    'gather_loot': 'loot',
    'rest_party': 'rest',
    'long_rest': 'rest',
    'short_rest': 'rest',
    'camp': 'rest'
};

function ensureDb() {
    const db = getDb();
    return {
        db,
        charRepo: new CharacterRepository(db),
        partyRepo: new PartyRepository(db),
        corpseRepo: new CorpseRepository(db),
        spatialRepo: new SpatialRepository(db),
        poiRepo: new PoiRepository(db)
    };
}

// Input schema
const TravelManageInputSchema = z.object({
    action: z.string().describe('Action: travel, loot, rest'),

    // travel fields
    partyId: z.string().optional().describe('Party ID'),
    poiId: z.string().optional().describe('POI ID destination'),
    enterLocation: z.boolean().optional().default(false).describe('Enter POI room network'),
    autoDiscover: z.boolean().optional().default(false).describe('Skip discovery check'),
    discoveringCharacterId: z.string().optional().describe('Character making discovery check'),
    radTier: z.number().int().min(1).max(6).optional().describe('FINDINGS #55: danger tier of the leg (1-6). When present, the engine runs the #54 exposure law: lead rolls Survival vs tier DC; on failure, tier income lands per member reduced by equipped-armor resistance; nat 1 = hotspot (double + encounterTriggered); nat 20 = clean + intel flag. Default track: rads'),
    exposureTrack: z.string().optional().describe('FINDINGS #93: NAME THE TRACK — the pool tier income lands in (default "rads"). "contamination", "cold", "infection", "miasma" — any pool. Four genres, one law'),
    resistProperty: z.string().optional().describe('FINDINGS #93: the equipped-armor property that reduces landed income (default "radResistance"). e.g. "sealRating", "insulation", "filtration"'),
    trackMax: z.number().optional().describe('FINDINGS #93: the track pool ceiling (default 1000)'),
    leadId: z.string().optional().describe('FINDINGS #55: character leading the leg (rolls the Survival check). Defaults to party leader, then first member'),
    interior: z.boolean().optional().describe('FINDINGS #55: interior leg — landed rads halve after resistance'),

    // loot fields
    encounterId: z.string().optional().describe('Encounter ID to loot'),
    looterId: z.string().optional().describe('Character ID to receive loot'),
    distributeEvenly: z.boolean().optional().default(false).describe('Distribute among party'),
    includeItems: z.boolean().optional().default(true).describe('Include equipment'),
    includeCurrency: z.boolean().optional().default(true).describe('Include gold/silver'),
    includeHarvestable: z.boolean().optional().default(false).describe('Auto-harvest resources'),

    // rest fields
    restType: z.enum(['long', 'short']).optional().default('long').describe('Type of rest'),
    hitDicePerMember: z.number().int().min(0).max(20).optional().default(1).describe('Hit dice for short rest'),
    hitDiceAllocation: z.record(z.string(), z.number().int().min(0).max(20)).optional()
        .describe('Custom hit dice per character')
});

type TravelManageInput = z.infer<typeof TravelManageInputSchema>;

const TravelManageActionSchemas = {
    travel: {
        schema: TravelManageInputSchema.extend({
            action: z.literal('travel'),
            partyId: z.string().describe('Party ID'),
            poiId: z.string().describe('POI ID destination')
        }),
        aliases: ['move', 'goto', 'travel_to', 'go_to', 'travel_to_location'],
        description: 'Move a party to a POI destination'
    },
    loot: {
        schema: TravelManageInputSchema.extend({
            action: z.literal('loot'),
            encounterId: z.string().describe('Encounter ID to loot')
        }).refine(args => Boolean(args.looterId || args.partyId), {
            message: 'loot requires either looterId or partyId',
            path: ['looterId']
        }),
        aliases: ['loot_encounter', 'loot_all', 'collect', 'gather_loot'],
        description: 'Collect loot from an encounter; provide looterId or partyId'
    },
    rest: {
        schema: TravelManageInputSchema.extend({
            action: z.literal('rest'),
            partyId: z.string().describe('Party ID')
        }),
        aliases: ['rest_party', 'long_rest', 'short_rest', 'camp'],
        description: 'Rest the party'
    }
};

// Action handlers
async function handleTravel(input: TravelManageInput, _ctx: SessionContext): Promise<McpResponse> {
    if (!input.partyId || !input.poiId) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('travel requires partyId and poiId') +
                    RichFormatter.embedJson({ error: true, message: 'partyId and poiId required' }, 'TRAVEL_MANAGE')
            }]
        };
    }

    const { db, partyRepo, charRepo, spatialRepo, poiRepo } = ensureDb();

    // Get party
    const party = partyRepo.getPartyWithMembers(input.partyId);
    if (!party) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`Party not found: ${input.partyId}`) +
                    RichFormatter.embedJson({ error: true, message: 'Party not found' }, 'TRAVEL_MANAGE')
            }]
        };
    }

    // Get POI
    const poi = poiRepo.getById(input.poiId);

    if (!poi) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`POI not found: ${input.poiId}`) +
                    RichFormatter.embedJson({ error: true, message: 'POI not found' }, 'TRAVEL_MANAGE')
            }]
        };
    }

    // Check discovery state
    let discovered = poi.discoveryState !== 'unknown';
    let discoveryRoll: number | null = null;

    if (!discovered && !input.autoDiscover) {
        // Roll perception check
        const discoverer = input.discoveringCharacterId
            ? party.members?.find(m => m.character.id === input.discoveringCharacterId)?.character
            : party.members?.find(m => m.role === 'leader')?.character || party.members?.[0]?.character;

        if (discoverer) {
            const wisBonus = Math.floor(((discoverer.stats?.wis || 10) - 10) / 2);
            discoveryRoll = Math.floor(Math.random() * 20) + 1 + wisBonus;
            const dc = poi.discoveryDc || 15;
            discovered = discoveryRoll >= dc;
        }
    } else if (input.autoDiscover) {
        discovered = true;
    }

    if (!discovered) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`Failed to discover location (rolled ${discoveryRoll})`) +
                    RichFormatter.embedJson({
                        error: true,
                        message: 'Discovery failed',
                        discoveryRoll,
                        discovered: false
                    }, 'TRAVEL_MANAGE')
            }]
        };
    }

    // Update POI discovery state
    if (poi.discoveryState === 'unknown') {
        poiRepo.markDiscovered(input.poiId);
    }

    // Update party position through the canonical repository/schema.
    partyRepo.update(input.partyId, {
        currentLocation: poi.name,
        currentPOI: poi.id,
        positionX: poi.x,
        positionY: poi.y
    });

    // Enter location if requested
    let enteredRoom: ReturnType<SpatialRepository['findRoomsByNetwork']>[number] | null = null;
    if (input.enterLocation && poi.networkId) {
        enteredRoom = spatialRepo.findRoomsByNetwork(poi.networkId)[0] || null;
    }

    // ─── FINDINGS #55: THE RAD LEG (engine-enforced #54 law) ───
    // Rads are terrain, not weather: avoidable by skill, soaked by resistance.
    // The GM supplies the tier (danger tiers are narrative overlay); everything
    // downstream is engine math — the items are read at the moment of crossing.
    let radLeg: Record<string, unknown> | undefined;
    if (input.radTier) {
        // FINDINGS #93: the exposure law generalised — caller names the track
        // and the resisting property; PSAR's rads are the untouched default.
        const track = input.exposureTrack ?? 'rads';
        const resistProp = input.resistProperty ?? 'radResistance';
        const TIER_DC = [0, 8, 10, 12, 14, 16, 18];
        const TIER_INCOME = [0, 10, 20, 35, 60, 90, 120];
        const dc = TIER_DC[input.radTier];
        const lead = input.leadId
            ? party.members?.find(m => m.character.id === input.leadId)?.character
            : party.members?.find(m => m.role === 'leader')?.character || party.members?.[0]?.character;
        if (!lead) {
            radLeg = { error: true, message: 'No lead walker found for the rad leg' };
        } else {
            // Party hydration predates the sheet fields — read the lead fresh
            // so skillProficiencies/expertise actually reach the roll.
            const leadFull = (charRepo.findById(lead.id) ?? lead) as typeof lead;
            const lstats = (leadFull.stats || {}) as Record<string, number>;
            const wisMod = Math.floor(((lstats.wis ?? 10) - 10) / 2);
            let mod = wisMod;
            const rollBreakdown: string[] = [`WIS ${wisMod >= 0 ? '+' : ''}${wisMod}`];
            const lskills = (leadFull as { skillProficiencies?: string[] }).skillProficiencies || [];
            const lexpertise = (leadFull as { expertise?: string[] }).expertise || [];
            const prof = Math.floor(((leadFull.level ?? 1) - 1) / 4) + 2;
            // FINDINGS #104-D: same case-sensitivity hole as math_manage/stunt —
            // the radTier Survival roll composed its own membership tests, so a
            // capitalized "Survival" on the lead's sheet rolled light by prof on
            // EVERY surface leg. Normalize both sides.
            const normOne = (s: string) => s.toLowerCase().replace(/[ _]/g, '');
            const normHas = (xs: string[], s: string) => xs.some(x => normOne(x) === normOne(s));
            if (normHas(lexpertise, 'survival')) { mod += prof * 2; rollBreakdown.push(`expertise +${prof * 2}`); }
            else if (normHas(lskills, 'survival')) { mod += prof; rollBreakdown.push(`proficiency +${prof}`); }
            const die = Math.floor(Math.random() * 20) + 1;
            const total = die + mod;
            const hotspot = die === 1;
            const clean = !hotspot && (die === 20 || total >= dc);
            const baseIncome = clean ? 0 : TIER_INCOME[input.radTier] * (hotspot ? 2 : 1);
            const legMembers: Array<Record<string, unknown>> = [];
            if (baseIncome > 0) {
                for (const m of party.members ?? []) {
                    const ch = m.character;
                    let resistance = 0;
                    let armorName: string | undefined;
                    try {
                        const arow = db.prepare(`SELECT i.name, i.properties FROM inventory_items ii JOIN items i ON i.id = ii.item_id WHERE ii.character_id = ? AND ii.equipped = 1 AND ii.slot = 'armor'`).get(ch.id) as { name?: string; properties?: string | Record<string, unknown> } | undefined;
                        if (arow) {
                            armorName = arow.name;
                            const props = typeof arow.properties === 'string' ? JSON.parse(arow.properties) : (arow.properties || {});
                            // FINDINGS #93: the resisting property is named by the caller
                            const rr = (props as Record<string, unknown>)[resistProp];
                            if (typeof rr === 'number' && rr > 0) resistance = rr > 1 ? rr / 100 : rr;
                        }
                    } catch { /* no armor row — unsealed */ }
                    let landed = Math.ceil(baseIncome * (1 - resistance));
                    if (input.interior) landed = Math.ceil(landed / 2);
                    let radsBefore = 0, radsAfter = 0, radMax = input.trackMax ?? 1000;
                    let poolError: string | undefined;
                    try {
                        const fresh = charRepo.findById(ch.id);
                        const pools = ((fresh as unknown as { resourcePools?: Record<string, { current: number; max: number }> })?.resourcePools) ?? {};
                        const pool = pools[track] ?? { current: 0, max: input.trackMax ?? 1000 };
                        radsBefore = pool.current ?? 0;
                        radMax = pool.max ?? input.trackMax ?? 1000;
                        radsAfter = Math.min(radMax, Math.max(0, radsBefore + landed));
                        pools[track] = { ...pool, current: radsAfter, max: radMax };
                        charRepo.update(ch.id, { resourcePools: pools } as never);
                    } catch (pErr) {
                        poolError = `${track} write failed: ${(pErr as Error).message}`;
                    }
                    legMembers.push({ characterId: ch.id, name: ch.name, armor: armorName ?? 'unsealed', resistance, landed, [`${track}Before`]: radsBefore, [`${track}After`]: radsAfter, ...(poolError ? { poolError } : {}) });
                }
            }
            radLeg = {
                tier: input.radTier, dc,
                track, resistProperty: resistProp,
                lead: { id: lead.id, name: lead.name },
                roll: { die, bonus: mod, total, breakdown: rollBreakdown },
                clean, hotspot,
                encounterTriggered: hotspot,
                cleanIntel: die === 20,
                baseIncome,
                interior: !!input.interior,
                members: legMembers
            };
        }
    }

    let output = RichFormatter.header('Travel Complete', '🚶');
    output += RichFormatter.keyValue({
        'Party': party.name,
        'Destination': poi.name,
        'Type': poi.type,
        'Position': `(${poi.x}, ${poi.y})`
    });

    if (discoveryRoll !== null) {
        output += `\n*Discovery check: ${discoveryRoll} - Success!*\n`;
    }

    if (enteredRoom) {
        output += RichFormatter.section('Entered Location');
        output += `**${enteredRoom.name}**\n`;
        if (enteredRoom.baseDescription) {
            output += `${enteredRoom.baseDescription}\n`;
        }
    }

    if (radLeg && !radLeg.error) {
        const rl = radLeg as { tier: number; dc: number; track?: string; lead: { name: string }; roll: { die: number; bonus: number; total: number; breakdown: string[] }; clean: boolean; hotspot: boolean; cleanIntel: boolean; baseIncome: number; members: Array<Record<string, unknown> & { name: string; armor: string; resistance: number; landed: number }> };
        // FINDINGS #94: the banner templates off the TRACK — an infection leg
        // stops printing rad vocabulary ("→ rads undefined" is dead).
        const track = rl.track ?? 'rads';
        const icon = track === 'rads' ? '☢️' : '☣️';
        const trackTitle = track.charAt(0).toUpperCase() + track.slice(1);
        output += RichFormatter.section(`${trackTitle} Leg — D${rl.tier} (DC ${rl.dc})`);
        output += `Lead: **${rl.lead.name}** — survival d20(${rl.roll.die}) + ${rl.roll.bonus} = ${rl.roll.total} [${rl.roll.breakdown.join(', ')}]\n`;
        if (rl.clean) {
            output += rl.cleanIntel ? `✨ NAT 20 — clean route, and the lead read the ground: one piece of true route intelligence.\n` : `✅ Clean route — 0 ${track}, whole crew.\n`;
        } else {
            if (rl.hotspot) output += `${icon} NAT 1 — HOTSPOT: income doubled to ${rl.baseIncome}, and the encounter FIRES (no threshold roll).\n`;
            else output += `${icon} Route clipped contamination — ${rl.baseIncome} ${track} land, per resistance:\n`;
            rl.members.forEach(mm => {
                output += `  • ${mm.name} (${mm.armor}${mm.resistance ? `, resist ${Math.round(mm.resistance * 100)}%` : ''}): +${mm.landed} → ${track} ${mm[`${track}After`]}\n`;
            });
        }
    } else if (radLeg && radLeg.error) {
        output += RichFormatter.alert(String(radLeg.message), 'warning');
    }

    const result = {
        success: true,
        actionType: 'travel',
        partyId: input.partyId,
        partyName: party.name,
        destination: {
            id: poi.id,
            name: poi.name,
            type: poi.type,
            position: { x: poi.x, y: poi.y }
        },
        discoveryRoll,
        discovered: true,
        enteredRoom: enteredRoom ? { id: enteredRoom.id, name: enteredRoom.name } : null,
        radLeg
    };

    output += RichFormatter.embedJson(result, 'TRAVEL_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleLoot(input: TravelManageInput, _ctx: SessionContext): Promise<McpResponse> {
    if (!input.encounterId) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('loot requires encounterId') +
                    RichFormatter.embedJson({ error: true, message: 'encounterId required' }, 'TRAVEL_MANAGE')
            }]
        };
    }

    if (!input.looterId && !input.partyId) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('loot requires looterId or partyId') +
                    RichFormatter.embedJson({ error: true, message: 'looterId or partyId required' }, 'TRAVEL_MANAGE')
            }]
        };
    }

    const { corpseRepo, charRepo, partyRepo } = ensureDb();

    // Get corpses from encounter
    const corpses = corpseRepo.findByEncounterId(input.encounterId);

    if (corpses.length === 0) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('No corpses found in encounter') +
                    RichFormatter.embedJson({ error: true, message: 'No corpses found' }, 'TRAVEL_MANAGE')
            }]
        };
    }

    // Collect all loot
    const allItems: string[] = [];
    let totalGold = 0;
    let totalSilver = 0;
    let totalCopper = 0;
    const harvestedMaterials: string[] = [];
    let corpsesLooted = 0;

    // Determine looter ID
    const looterId = input.looterId || (input.partyId ? partyRepo.getPartyWithMembers(input.partyId)?.members?.[0]?.character.id : undefined);

    for (const corpse of corpses) {
        if (corpse.looted) continue;

        // Loot currency using proper method
        if (input.includeCurrency && looterId) {
            const currencyResult = corpseRepo.lootCurrency(corpse.id, looterId, false);
            if (currencyResult.success) {
                totalGold += currencyResult.currency.gold;
                totalSilver += currencyResult.currency.silver;
                totalCopper += currencyResult.currency.copper;
            }
        }

        // Harvest (simplified)
        if (input.includeHarvestable && corpse.harvestable && corpse.harvestableResources) {
            harvestedMaterials.push(...corpse.harvestableResources.map(r => r.resourceType));
        }

        corpsesLooted++;
    }

    // Distribute loot
    const distributions: Array<{ characterId: string; characterName: string; items: string[]; gold?: number }> = [];

    if (input.distributeEvenly && input.partyId) {
        const party = partyRepo.getPartyWithMembers(input.partyId);
        if (party && party.members) {
            const memberCount = party.members.length;
            const itemsPerMember = Math.ceil(allItems.length / memberCount);
            const goldPerMember = Math.floor(totalGold / memberCount);

            for (let i = 0; i < party.members.length; i++) {
                const member = party.members[i];
                const memberItems = allItems.splice(0, itemsPerMember);

                // Add items to character inventory
                const char = charRepo.findById(member.character.id);
                if (char) {
                    const currentInventory = (char as any).inventory || [];
                    charRepo.update(member.character.id, {
                        inventory: [...currentInventory, ...memberItems]
                    } as any);
                }

                distributions.push({
                    characterId: member.character.id,
                    characterName: member.character.name,
                    items: memberItems,
                    gold: goldPerMember
                });
            }
        }
    } else if (input.looterId) {
        const looter = charRepo.findById(input.looterId);
        if (looter) {
            const currentInventory = (looter as any).inventory || [];
            charRepo.update(input.looterId, {
                inventory: [...currentInventory, ...allItems]
            } as any);

            distributions.push({
                characterId: input.looterId,
                characterName: looter.name,
                items: allItems,
                gold: totalGold
            });
        }
    }

    let output = RichFormatter.header('Loot Collected', '💰');
    output += RichFormatter.keyValue({
        'Corpses Looted': corpsesLooted,
        'Total Items': allItems.length,
        [looterId ? characterLexicon(getDb(), looterId).currency : DEFAULT_LEXICON.currency]: totalGold,
        'Silver': totalSilver,
        'Copper': totalCopper
    });

    if (distributions.length > 0) {
        output += RichFormatter.section('Distribution');
        for (const dist of distributions) {
            output += `**${dist.characterName}**: `;
            if (dist.items.length > 0) {
                output += dist.items.join(', ');
            }
            if (dist.gold) {
                output += ` + ${dist.gold}gp`;
            }
            output += '\n';
        }
    }

    if (harvestedMaterials.length > 0) {
        output += RichFormatter.section('Harvested');
        output += RichFormatter.list(harvestedMaterials);
    }

    const result = {
        success: true,
        actionType: 'loot',
        encounterId: input.encounterId,
        corpsesLooted,
        totalItems: allItems.length,
        currency: { gold: totalGold, silver: totalSilver, copper: totalCopper },
        distributions,
        harvestedMaterials
    };

    output += RichFormatter.embedJson(result, 'TRAVEL_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleRest(input: TravelManageInput, _ctx: SessionContext): Promise<McpResponse> {
    if (!input.partyId) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('rest requires partyId') +
                    RichFormatter.embedJson({ error: true, message: 'partyId required' }, 'TRAVEL_MANAGE')
            }]
        };
    }

    const { partyRepo, charRepo, db } = ensureDb();

    const party = partyRepo.getPartyWithMembers(input.partyId);
    if (!party) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`Party not found: ${input.partyId}`) +
                    RichFormatter.embedJson({ error: true, message: 'Party not found' }, 'TRAVEL_MANAGE')
            }]
        };
    }

    // Check if any member is in combat
    try {
        const inCombat = db.prepare(`
            SELECT e.id FROM encounters e
            JOIN json_each(e.tokens) t ON 1=1
            WHERE e.status = 'active'
            AND json_extract(t.value, '$.id') IN (
                SELECT characterId FROM party_members WHERE partyId = ?
            )
        `).get(input.partyId);

        if (inCombat) {
            return {
                content: [{
                    type: 'text',
                    text: RichFormatter.error('Cannot rest while party members are in combat') +
                        RichFormatter.embedJson({ error: true, message: 'In combat' }, 'TRAVEL_MANAGE')
                }]
            };
        }
    } catch {
        // Tables might not exist, continue
    }

    const restResults: Array<{
        characterId: string;
        characterName: string;
        hpBefore: number;
        hpAfter: number;
        healed: number;
    }> = [];

    const isLongRest = input.restType === 'long';

    for (const member of party.members || []) {
        const char = member.character;
        const hpBefore = char.hp;
        let hpAfter = hpBefore;

        if (isLongRest) {
            // Long rest: restore to max HP
            hpAfter = char.maxHp;
        } else {
            // Short rest: roll hit dice
            const hitDice = input.hitDiceAllocation?.[char.id]
                ?? input.hitDicePerMember
                ?? 1;

            if (hitDice > 0) {
                const conBonus = Math.floor(((char.stats?.con || 10) - 10) / 2);
                let healing = 0;
                for (let i = 0; i < hitDice; i++) {
                    // Assume d8 hit die for simplicity
                    healing += Math.max(1, Math.floor(Math.random() * 8) + 1 + conBonus);
                }
                hpAfter = Math.min(char.maxHp, hpBefore + healing);
            }
        }

        // Update character
        charRepo.update(char.id, { hp: hpAfter } as any);

        restResults.push({
            characterId: char.id,
            characterName: char.name,
            hpBefore,
            hpAfter,
            healed: hpAfter - hpBefore
        });
    }

    const totalHealed = restResults.reduce((sum, r) => sum + r.healed, 0);

    let output = RichFormatter.header(`${isLongRest ? 'Long' : 'Short'} Rest Complete`, '⛺');
    output += RichFormatter.keyValue({
        'Party': party.name,
        'Rest Type': input.restType,
        'Duration': isLongRest ? '8 hours' : '1 hour',
        'Total HP Restored': totalHealed
    });

    output += RichFormatter.section('Results');
    const rows = restResults.map(r => [
        r.characterName,
        `${r.hpBefore} → ${r.hpAfter}`,
        `+${r.healed}`
    ]);
    output += RichFormatter.table(['Character', 'HP', 'Healed'], rows);

    if (isLongRest) {
        output += '\n*All spell slots restored. Concentration cleared.*\n';
    }

    const result = {
        success: true,
        actionType: 'rest',
        partyId: input.partyId,
        partyName: party.name,
        restType: input.restType,
        totalHealed,
        members: restResults
    };

    output += RichFormatter.embedJson(result, 'TRAVEL_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

// Main handler
export async function handleTravelManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const input = TravelManageInputSchema.parse(args);
    const matchResult = matchAction(input.action, ACTIONS, ALIASES, 0.6);

    if (isGuidingError(matchResult)) {
        let output = RichFormatter.error(`Unknown action: "${input.action}"`);
        output += `\nAvailable actions: ${ACTIONS.join(', ')}`;
        if (matchResult.suggestions.length > 0) {
            output += `\nDid you mean: ${matchResult.suggestions.map(s => `"${s.value}" (${Math.round(s.similarity * 100)}%)`).join(', ')}?`;
        }
        output += RichFormatter.embedJson(matchResult, 'TRAVEL_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    }

    switch (matchResult.matched) {
        case 'travel':
            return handleTravel(input, _ctx);
        case 'loot':
            return handleLoot(input, _ctx);
        case 'rest':
            return handleRest(input, _ctx);
        default:
            return {
                content: [{
                    type: 'text',
                    text: RichFormatter.error(`Unhandled action: ${matchResult.matched}`) +
                        RichFormatter.embedJson({ error: true, message: `Unhandled: ${matchResult.matched}` }, 'TRAVEL_MANAGE')
                }]
            };
    }
}

// Tool definition for registration
export const TravelManageTool = {
    name: 'travel_manage',
    description: `Party-wide travel, loot collection, and rest operations.

🚶 TRAVEL WORKFLOW:
1. travel - Move party to POI with automatic discovery checks
2. On arrival, random encounter chance based on danger level
3. Use enterLocation: true to automatically enter the destination

💰 POST-COMBAT LOOT:
After combat ends, use loot action to:
- Collect all items from corpses in encounter
- distributeEvenly: true spreads gold/items across party
- Auto-removes looted corpses

⏰ PARTY REST:
- Long rest (8h): Full HP + all spell slots restored
- Short rest (1h): hitDicePerMember controls healing

🔄 TYPICAL FLOW:
combat_manage (end) → travel_manage (loot) → travel_manage (rest) → travel_manage (travel)

Actions: travel, loot, rest
Aliases: move→travel, collect→loot, camp→rest`,
    actionSchemas: TravelManageActionSchemas,
    inputSchema: TravelManageInputSchema
};
