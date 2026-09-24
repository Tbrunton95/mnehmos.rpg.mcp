// ── ПДА / PDA RENDER KERNEL — FINDINGS #62, Wave A ──────────────────
// The banner is a PURE FUNCTION of the embedded JSON. Renderers here
// receive the same parsed result object that gets embedded; they can
// render only what the payload contains, so banner and JSON cannot
// diverge. This is the structural kill of the #35 formatter family.
//
// LANGUAGE LAW (Tom's ruling, 2026-08-15): every load-bearing string —
// outcomes, labels on numbers, band names, refusal reasons — is ENGLISH.
// Cyrillic is confined to decorative chrome (the ПДА badge). The lore:
// bootleg firmware with a cracked English localisation — somebody needed
// to read his own rad count.
//
// NO EMOJI. Monospace-stable, box-drawing-safe glyphs only.

export type Cell = { kind: 'label' | 'value'; text: string };
export const L = (text: string): Cell => ({ kind: 'label', text });
export const V = (text: string | number): Cell => ({ kind: 'value', text: String(text) });

const GLYPHS = Object.freeze({
    rail: '▌', pass: '✔', fail: '✘', nat20: '✦', nat1: '✖', warn: '⚠',
    dmg: '⌁', ammo: '▣', barFull: '▓', barEmpty: '░', compFull: '█',
    pipLive: '●', pipEmpty: '○', pipDead: '✖', sep: '·', to: '▸', badge: 'ПДА',
    // #62-b (Tom's ruling): technical dingbats are in — the phone-game set
    // stays banned. ☢ owns radiation everywhere it appears; ☠ is reserved
    // for death saves and the flatline (Wave B).
    rad: '☢', death: '☠'
});
const PLAIN_GLYPHS = Object.freeze({
    rail: '|', pass: 'OK', fail: 'X', nat20: '*20*', nat1: '*1*', warn: '!',
    dmg: '>', ammo: '#', barFull: '#', barEmpty: '-', compFull: '#',
    pipLive: 'o', pipEmpty: '.', pipDead: 'x', sep: '.', to: '->', badge: 'PDA',
    rad: '[R]', death: '[D]'
});
// plainOutput: theme is never load-bearing. Env-flag only.
export const plain = (): boolean => process.env.PDA_PLAIN === '1';
export const G = () => (plain() ? PLAIN_GLYPHS : GLYPHS);

// ── THE PSI GUARD — at the function, not the call site ──────────────
// Hidden pools are STRUCTURALLY UNPRINTABLE. Any renderer that prints
// pools flows through renderPoolLine; the deny-set lives here so a
// future generic pool printer inherits the exclusion by construction.
export const UNPRINTABLE_POOLS: ReadonlySet<string> = Object.freeze(new Set(['psi']));

// ── bars & bands ─────────────────────────────────────────────────────
export function bar(value: number, cells: number, max: number, fullGlyph?: string): string {
    const g = G();
    const full = fullGlyph ?? g.barFull;
    const v = Math.max(0, Math.min(max, value));
    const filled = v <= 0 ? 0 : Math.max(1, Math.min(cells, Math.ceil((v * cells) / max)));
    return full.repeat(filled) + g.barEmpty.repeat(cells - filled);
}
export function radBand(v: number): string {
    if (v >= 850) return 'TERMINAL';
    if (v >= 650) return 'CRITICAL';
    if (v >= 450) return 'POISONED';
    if (v >= 250) return 'SICK';
    if (v >= 100) return 'UNEASY';
    return 'CLEAN';
}
export function composureBand(v: number): string {
    if (v >= 61) return 'STEADY';
    if (v >= 31) return 'FRAYED';
    return 'BREAKING';
}

// ── callsign extraction: 'Maksim "Psar" Volkov' → PSAR ──────────────
export function callsign(name: string): string {
    const m = /"([^"]+)"/.exec(name || '');
    return (m ? m[1] : (name || '').split(/\s+/)[0] || '???').toUpperCase();
}

// ── SIGNAL DEGRADATION — typed guard (feature ships Wave C; the guard
// ships NOW so nothing is ever written un-guardable). corrupt() maps
// over cells and its substitution function is typed LabelCell→LabelCell:
// the code path to a ValueCell's text DOES NOT EXIST. Numbers, outcomes,
// breakdown values, pool figures, trait identity strings — all V() —
// pass by identity. The die is never allowed to flicker.
export function corrupt(rows: Cell[][], signal: 0 | 1 | 2 | 3): Cell[][] {
    if (!signal) return rows;
    const p = signal === 1 ? 0.05 : signal === 2 ? 0.15 : 0.3;
    const speckle = (c: Cell & { kind: 'label' }): Cell =>
        ({ kind: 'label', text: c.text.replace(/[A-Za-zА-Яа-я]/g, ch => (Math.random() < p ? '▒' : ch)) });
    return rows.map(row => row.map(c => (c.kind === 'label' ? speckle(c as Cell & { kind: 'label' }) : c)));
}

// ── emit: rows → railed text ─────────────────────────────────────────
export function emit(rows: Cell[][], signal: 0 | 1 | 2 | 3 = 0): string {
    const g = G();
    return corrupt(rows, signal)
        .map(row => `${g.rail} ${row.map(c => c.text).join('')}`)
        .join('\n') + '\n';
}

// ── shared payload shapes (duck-typed off the embedded JSON) ─────────
interface CheckPayload {
    actionType: string; characterName?: string; skill?: string; ability?: string;
    rolls?: number[]; natural?: number; bonus?: number; total?: number;
    breakdown?: string[]; dc?: number; outcome?: string; message?: string;
}
interface PoolPayload {
    characterName?: string; characterId?: string; pool?: string;
    before?: number; delta?: number; current?: number; max?: number; clamped?: boolean;
}

// ── ПРОВЕРКА / CHECK — the three character rolls (#66: full disclosure) ─
// ── THE OUTCOME TOKEN — #67-H: pure glyph, no markdown ──────────────
// Tom's raw pane renders no markdown; his chat blocks live in code fences —
// markdown NEVER renders anywhere in his workflow. The #66-B H3 and #67-G
// diff fence printed as literal ### and backticks the whole time. The head
// is now a full-width glyph bar: the verdict's own glyph, repeated, flanking
// the word. Unmissable in monospace, identical in every pane, plain-safe.
export function outcomeHead(token: string, summary: string, sentiment: 'good' | 'bad' | 'neutral' = 'neutral'): string {
    const g = G();
    if (sentiment === 'neutral') return `${g.rail} ${token} — ${summary}\n`;
    const parts = token.split(' ');
    const glyph = plain() ? '=' : parts[0];
    const word = plain() ? token : (parts.slice(1).join(' ') || token);
    const bar = glyph.repeat(12);
    return `${g.rail} ${bar}  ${word}  ${bar}\n${g.rail} ${summary}\n`;
}

// ── STORYTELLER POOL — #67-W: World of Darkness lane ────────────────
export function renderPoolCheck(p: {
    characterName?: string; characterId?: string;
    poolLabel?: string; poolSize?: number; difficulty?: number;
    dice?: number[]; successesRaw?: number; onesCancelled?: number;
    successes?: number; botch?: boolean; specialty?: boolean;
    willpowerAuto?: boolean; seed?: string; calculationId?: string;
}): string {
    const g = G();
    const n = p.successes ?? 0;
    const token = p.botch ? '💀 BOTCH' : n >= 1 ? `${g.pass} ${n} SUCCESS${n > 1 ? 'ES' : ''}` : `${g.fail} FAILURE`;
    const head = outcomeHead(token,
        `${(p.poolLabel ?? 'POOL').toUpperCase()} ${g.sep} ${p.poolSize ?? '?'}d10 vs diff ${p.difficulty ?? '?'}`,
        p.botch ? 'bad' : n >= 1 ? 'good' : 'bad');
    const rows: Cell[][] = [];
    if (Array.isArray(p.dice))
        rows.push([V(callsign(p.characterName ?? '???')), L('    d10 ['), V(p.dice.join(', ')), L(']')]);
    const math: Cell[] = [L('successes '), V(p.successesRaw ?? n)];
    if ((p.onesCancelled ?? 0) > 0) math.push(L(' − '), V(p.onesCancelled!), L(' (ones cancel)'), L(' = '), V(n));
    if (p.specialty) math.push(L(`  ${g.sep} `), V('specialty: 10s double'));
    if (p.willpowerAuto) math.push(L(`  ${g.sep} `), V('+1 willpower (auto)'));
    rows.push(math);
    if (p.botch) rows.push([V(`${g.nat1} zero successes with ones showing — the Beast grins`)]);
    if (p.seed || p.calculationId)
        rows.push([L('seed '), V(p.seed ?? '?'), ...(p.calculationId ? [L(` ${g.sep} calc `), V(p.calculationId.slice(0, 8))] : [])]);
    if (p.characterId) rows.push([L(`${g.sep} `), V(callsign(p.characterName ?? '')), L(` ${g.sep} `), V(p.characterId.slice(0, 8))]);
    return head + emit(rows);
}

export function renderCheck(p: CheckPayload): string {
    const g = G();
    const rows: Cell[][] = [];
    const isSave = p.actionType === 'roll_saving_throw';
    const isStunt = p.actionType === 'stunt';
    const kindLabel = isStunt ? 'STUNT' : isSave ? 'SAVE' : 'CHECK';
    const what = p.skill ? p.skill.toUpperCase() + (p.ability ? ' — ' + p.ability.toUpperCase() : '') : (p.ability ?? '???').toUpperCase();

    // #66-B: OUTCOME TOKEN — H3 + bold, before any number the reader has to
    // interpret. ⚡/💀 fire on ENGINE crit flags only (stunts); checks and
    // saves keep 5e honesty — a nat 20 does not auto-pass, so the token
    // stays SUCCESS/FAILED and the NAT rail row carries the die.
    let head: string;
    if (typeof p.dc === 'number') {
        const passed = p.outcome === 'SUCCESS';
        const margin = (p.total ?? 0) - p.dc;
        const summary = `${what} ${kindLabel} ${g.sep} ${p.total ?? '?'} vs DC ${p.dc} ${g.sep} by ${margin >= 0 ? '+' : ''}${margin}`;
        const cs = isStunt && (p as { criticalSuccess?: boolean }).criticalSuccess;
        const cf = isStunt && (p as { criticalFailure?: boolean }).criticalFailure;
        const token = cs ? `⚡ CRITICAL` : cf ? `💀 FUMBLE` : passed ? `${g.pass} SUCCESS` : `${g.fail} FAILED`;
        head = outcomeHead(token, (cs || cf) ? `${summary} ${g.sep} ${passed ? 'SUCCESS' : 'FAILED'}` : summary, (cs || (!cf && passed)) ? 'good' : 'bad');
    } else {
        head = outcomeHead(`${plain() ? '#' : '◆'} NO TARGET SET`, `${what} ${kindLabel} ${g.sep} total ${p.total ?? '?'}`);
    }

    const sign = (p.bonus ?? 0) >= 0 ? '+' : '';
    rows.push([V(callsign(p.characterName ?? '')), L('    d20['), V(p.natural ?? '?'), L('] '),
        V(`${sign}${p.bonus ?? 0}`), L(' → '), V(p.total ?? '?')]);

    if (isStunt) {
        if ((p as { criticalSuccess?: boolean }).criticalSuccess) rows.push([V(`${g.nat20} CRITICAL`)]);
        if ((p as { criticalFailure?: boolean }).criticalFailure) rows.push([V(`${g.nat1} CRITICAL FAILURE`)]);
    } else {
        if (p.natural === 20) rows.push([V(`${g.nat20} NAT 20`)]);
        if (p.natural === 1) rows.push([V(`${g.nat1} NAT 1`)]);
    }
    if (Array.isArray(p.rolls) && p.rolls.length > 1)
        rows.push([L('─ dice '), V(p.rolls.join(', ')), L(' '), L(g.sep + ' kept '), V(p.natural ?? '?')]);

    // #66 LANE DISCLOSURE — when structured contributions ride the payload,
    // every number gets a lane; nothing renders unlabelled. Falls back to
    // legacy breakdown strings for payloads that predate the shape (stunt).
    const contribs = (p as { contributions?: Array<{ label: string; value: number; lane: string }> }).contributions;
    if (Array.isArray(contribs) && contribs.length) {
        const laneOrder = ['SHEET', 'ENGINE', 'EFFECT', 'SITUATIONAL'];
        for (const lane of laneOrder) {
            const inLane = contribs.filter(c => c.lane === lane);
            if (!inLane.length) continue;
            const cells: Cell[] = [L(lane.padEnd(12))];
            inLane.forEach((c, i) => {
                if (i) cells.push(L(` ${g.sep} `));
                cells.push(V(`${c.label} ${c.value >= 0 ? '+' : ''}${c.value}`));
            });
            rows.push(cells);
        }
        const audit = contribs.filter(c => c.lane === 'DECLARED');
        if (audit.length) {
            const cells: Cell[] = [L('audit — not summed: ')];
            audit.forEach((c, i) => { if (i) cells.push(L(` ${g.sep} `)); cells.push(V(`${c.label} ${c.value >= 0 ? '+' : ''}${c.value}`)); });
            rows.push(cells);
        }
    } else {
        const bd = Array.isArray(p.breakdown) ? p.breakdown : [];
        const declared = bd.filter(b => b.includes('(declared, engine-computed)'));
        const warns0 = bd.filter(b => b.startsWith('⚠'));
        const rest = bd.filter(b => !warns0.includes(b) && !declared.includes(b));
        if (rest.length) rows.push([L('─ '), V(rest.join(` ${g.sep} `))]);
        for (const d of declared) rows.push([L('⟨declared⟩ '), V(d.replace(' (declared, engine-computed)', ''))]);
    }

    const warns = (Array.isArray(p.breakdown) ? p.breakdown : []).filter(b => b.startsWith('⚠'));
    for (const w of warns) rows.push([V(plain() ? w.replace('⚠', '!') : w)]);

    // #66-B: provenance — any roll can be pointed at.
    const cid = (p as { characterId?: string }).characterId;
    if (cid) rows.push([L(`${g.sep} `), V(callsign(p.characterName ?? '')), L(` ${g.sep} `), V(cid.slice(0, 8))]);

    return head + emit(rows);
}

// ── OPPOSED — #67: two compositions, one verdict ─────────────────────
export function renderOpposed(p: {
    initiator?: CheckPayload & { characterId?: string };
    defender?: CheckPayload & { characterId?: string };
    winner?: string; winnerName?: string; margin?: number;
}): string {
    const g = G();
    const i = p.initiator ?? {} as CheckPayload;
    const d = p.defender ?? {} as CheckPayload;
    const iName = callsign(i.characterName ?? '???');
    const dName = callsign(d.characterName ?? '???');
    const what = (c: CheckPayload) => (c.skill ?? c.ability ?? '???').toUpperCase();
    const token = p.winner === 'initiator' ? `${g.pass} ${iName} WINS`
        : p.winner === 'defender' ? `${g.fail} ${dName} HOLDS`
        : `${plain() ? '#' : '◆'} TIE — STATUS QUO`;
    const head = outcomeHead(token,
        `OPPOSED ${g.sep} ${iName} ${what(i)} ${i.total ?? '?'} vs ${dName} ${what(d)} ${d.total ?? '?'}${typeof p.margin === 'number' && p.winner !== 'tie' ? ` ${g.sep} by ${p.margin}` : ''}`,
        p.winner === 'initiator' ? 'good' : p.winner === 'defender' ? 'bad' : 'neutral');

    const rows: Cell[][] = [];
    const side = (c: CheckPayload, name: string) => {
        const sign = (c.bonus ?? 0) >= 0 ? '+' : '';
        rows.push([V(name), L('    d20['), V(c.natural ?? '?'), L('] '), V(`${sign}${c.bonus ?? 0}`), L(' → '), V(c.total ?? '?')]);
        if (Array.isArray(c.rolls) && c.rolls.length > 1)
            rows.push([L('  ─ dice '), V(c.rolls.join(', ')), L(` ${g.sep} kept `), V(c.natural ?? '?')]);
        const contribs = (c as { contributions?: Array<{ label: string; value: number; lane: string }> }).contributions ?? [];
        const summed = contribs.filter(x => x.lane !== 'DECLARED');
        if (summed.length)
            rows.push([L('  '), V(summed.map(x => `${x.lane} ${x.label} ${x.value >= 0 ? '+' : ''}${x.value}`).join(` ${g.sep} `))]);
        const warns = (Array.isArray(c.breakdown) ? c.breakdown : []).filter(b => b.startsWith('⚠'));
        for (const w of warns) rows.push([V(plain() ? w.replace('⚠', '!') : w)]);
    };
    side(i, iName);
    side(d, dName);
    return head + emit(rows);
}
export function renderRawRoll(p: { expression?: string; total?: number; rolls?: unknown[]; successes?: number; botches?: number; successThreshold?: number; dc?: number; outcome?: string; seed?: string; calculationId?: string }): string {
    const g = G();
    const rows: Cell[][] = [];
    let head: string;
    if (typeof p.successes === 'number') {
        head = outcomeHead('POOL ROLL', `${p.expression ?? '?'} ${g.sep} ${p.successes} successes vs ${p.successThreshold ?? '?'}+`);
        if (typeof p.botches === 'number' && p.botches > 0) rows.push([V(`${g.nat1} botches: ${p.botches}`)]);
    } else if (typeof p.dc === 'number') {
        // #66-B: dc landed on the roll path (bug fixed) — the token evaluates.
        const passed = p.outcome === 'SUCCESS';
        const margin = (p.total ?? 0) - p.dc;
        head = outcomeHead(passed ? `${g.pass} SUCCESS` : `${g.fail} FAILED`,
            `${p.expression ?? '?'} ROLL ${g.sep} ${p.total ?? '?'} vs DC ${p.dc} ${g.sep} by ${margin >= 0 ? '+' : ''}${margin}`, passed ? 'good' : 'bad');
    } else {
        head = outcomeHead(`${plain() ? '#' : '◆'} NO TARGET SET`, `${p.expression ?? '?'} RAW ROLL ${g.sep} total ${p.total ?? '?'}`);
        rows.push([L('no DC passed — outcome not evaluated')]);
    }
    if (Array.isArray(p.rolls) && p.rolls.length) for (const line of p.rolls) rows.push([L('  '), V(String(line))]);
    if (p.seed || p.calculationId) rows.push([L('seed '), V(p.seed ?? '?'), ...(p.calculationId ? [L(` ${g.sep} calc `), V(p.calculationId.slice(0, 8))] : [])]);
    return head + emit(rows);
}
// ── ЖУРНАЛ / LEDGER — pool movement ──────────────────────────────────
// The psi guard lives HERE: an unprintable pool renders as an accepted
// entry with the figures elided. The JSON keeps the values — the JSON
// is data and the GM's read channel, not the formatter.
export function renderPoolLine(p: PoolPayload): Cell[][] {
    const g = G();
    const pool = (p.pool ?? '').toLowerCase();
    if (UNPRINTABLE_POOLS.has(pool)) return [[L('entry accepted')]];
    const delta = p.delta ?? 0;
    const row: Cell[] = [
        V(pool || '???'), L('    '), V(p.before ?? '?'), L(` ${g.to} `), V(p.current ?? '?'),
        L('  ('), V(`${delta >= 0 ? '+' : ''}${delta}`), L(')')
    ];
    if (p.clamped) row.push(L('  [clamped]'));
    if (pool === 'rads') {
        // #62-b: the trefoil owns radiation — the single biggest 'looks
        // radiation' win, and it teaches itself.
        row.unshift(L(g.rad + ' '));
        row.push(L('    '), V(bar(p.current ?? 0, 8, 1000)), L(' '), V(radBand(p.current ?? 0)));
    } else if (pool === 'composure') {
        row.push(L('    '), V(bar(p.current ?? 0, 10, p.max ?? 100, G().compFull)), L(' '), V(composureBand(p.current ?? 0)));
    }
    return [row];
}
export function renderLedger(p: PoolPayload): string {
    const rows: Cell[][] = [[L('LEDGER '), L(G().sep + ' '), V(callsign(p.characterName ?? p.characterId ?? '???'))]];
    rows.push(...renderPoolLine(p));
    return emit(rows);
}

// ── ОТКАЗ / REFUSAL ──────────────────────────────────────────────────
// 'NO WRITE' is appended INSIDE this function — #59's law made visible
// in the same breath as every refusal. Callers must only use refuse()
// on paths where nothing was written; that is a claim, and claims must
// be true (math_manage qualifies wholesale: it never writes anything).
export function refuse(reason: string, detail?: string): string {
    const g = G();
    const rows: Cell[][] = [[V(`${g.nat1} REFUSED`), L(' — '), V(reason)]];
    if (detail) rows.push([L(detail)]);
    rows.push([V('NO WRITE')]);
    return emit(rows);
}

// ── ОТКАЗ from a payload — the claim travels from the throw site (#64) ─
// Prints NO WRITE if and only if the payload asserts writes:'none'. A
// refusal rendering WITHOUT the line means the throw site could not
// prove write-freedom — a finding, not a formatting choice.
export function refuseFromPayload(p: { message?: string; hint?: string; writes?: string }): string {
    const g = G();
    const rows: Cell[][] = [[V(`${g.nat1} REFUSED`), L(' — '), V(p.message ?? 'Unknown error')]];
    if (p.hint) rows.push([L(p.hint)]);
    if (p.writes === 'none') rows.push([V('NO WRITE')]);
    return emit(rows);
}

// ── THE STRIP — scene-block chrome; the dosimeter is always visible ────
// The 8-cell bar maps the 01 §2 band table — load-bearing, not decor.
// ПДА is the one Cyrillic residue (Tom's language ruling).
export function renderStrip(ctx: { callsign?: string; day?: number | string; time?: string; rads?: number; badge?: string }): string {
    const g = G();
    const cs = (ctx.callsign ?? '???').toUpperCase();
    const clock = ctx.day !== undefined && ctx.time ? ` ─ D${ctx.day} ${g.sep} ${ctx.time} ─` : ' ─';
    const dosim = typeof ctx.rads === 'number' ? ` ${g.rad} ${bar(ctx.rads, 8, 1000)} ${ctx.rads} ─` : ' ─';
    const badge = ctx.badge === undefined ? g.badge : ctx.badge;
    const head = badge ? `${badge} ─── ` : '';
    if (ctx.day === undefined && typeof ctx.rads !== 'number') {
        // Nothing to show after the name: close the strip there.
        return plain() ? `+- ${head.replace(/─/g, '-')}${cs} --+\n` : `╓─ ${head}${cs} ──╖\n`;
    }
    if (plain()) return `+- ${head.replace(/─/g, '-')}${cs} -${clock.replace(/─/g, '-')}${dosim.replace(/─/g, '-')}-+\n`;
    return `╓─ ${head}${cs} ──${clock}─${dosim}──╖\n`;
}

// ── СОСТОЯНИЕ / STATUS BLOCK — the 00-schema block from reads (#64) ───
// Takes NAMED fields only — no pool map is ever passed in, so a hidden
// pool cannot reach this function even by a future caller's mistake.
export interface StatusInput {
    characterName?: string; hp?: number; maxHp?: number;
    rads?: number; composure?: number; composureMax?: number;
    weaponName?: string; weaponCondition?: number; weaponCeiling?: number;
    weaponAttachments?: Array<{ slot: string; name: string }>;
    conditions?: Array<{ name?: string; duration?: number } | string>;
    effects?: string[]; gold?: number; currencyLabel?: string; badge?: string;
    day?: number | string; time?: string; weather?: string;
    // Table rules status_block: the tiny block.
    compact?: boolean;
    corePool?: { name: string; current: number; max: number };
    location?: string; objective?: string; moreConditions?: number;
}
/**
 * Close a strip and its rows into one box: the strip's rule and the bottom
 * rule both run to the widest line, so the frame never goes ragged.
 */
function framed(strip: string, body: string): string {
    const rows = body.replace(/\n$/, '').split('\n');
    const top = strip.replace(/\n$/, '');
    const fill = plain() ? '-' : '─';
    const open = top.slice(0, -1).replace(new RegExp(`${fill}+$`), '');
    const close = top.slice(-1);
    const width = Math.max(open.length + 3, ...rows.map(r => r.length + 1));
    const bottom = plain() ? `+${'-'.repeat(width - 2)}+` : `╙${'─'.repeat(width - 2)}╜`;
    return `${open}${fill.repeat(width - open.length - 1)}${close}\n${rows.join('\n')}\n${bottom}\n`;
}

export function renderStatusBlock(d: StatusInput): string {
    const g = G();
    if (d.compact) {
        // HP, core pool, location, objective, one or two conditions.
        const rows: Cell[][] = [];
        const top: Cell[] = [L('HP '), V(`${d.hp ?? '?'}/${d.maxHp ?? '?'}`)];
        if (d.corePool) top.push(L(` ${g.sep} ${d.corePool.name.toUpperCase()} `), V(`${d.corePool.current}/${d.corePool.max}`));
        rows.push(top);
        if (d.location) rows.push([L('AT  '), V(d.location)]);
        if (d.objective) rows.push([L('OBJ '), V(d.objective)]);
        // One condition a row: a long name never runs the frame off the edge.
        for (const c of d.conditions ?? []) {
            rows.push([V(typeof c === 'string' ? c : `${c.name}${c.duration ? ` (${c.duration}d)` : ''}`)]);
        }
        if (d.moreConditions) rows.push([L(`+${d.moreConditions} more`)]);
        return framed(renderStrip({ callsign: callsign(d.characterName ?? '???'), badge: d.badge }), emit(rows));
    }
    let out = renderStrip({ callsign: callsign(d.characterName ?? '???'), day: d.day, time: d.time, rads: d.rads, badge: d.badge });
    const rows: Cell[][] = [];
    rows.push([L('HP '), V(`${d.hp ?? '?'}/${d.maxHp ?? '?'}`)]);
    if (typeof d.rads === 'number')
        rows.push([L(g.rad + ' '), L('RADS '), V(d.rads), L('   '), V(bar(d.rads, 8, 1000)), L(' '), V(radBand(d.rads))]);
    if (typeof d.composure === 'number')
        rows.push([L('COMPOSURE '), V(d.composure), L('   '), V(bar(d.composure, 10, d.composureMax ?? 100, g.compFull)), L(' '), V(composureBand(d.composure))]);
    if (d.weaponName) {
        const w: Cell[] = [L('WEAPON: '), V(d.weaponName)];
        if (typeof d.weaponCondition === 'number') {
            const c = d.weaponCondition;
            w.push(L(' — cond '), V(c), L(' '), L(g.sep + ' jam risk: '), V(c >= 75 ? 'low' : c >= 50 ? 'nat 1' : c >= 25 ? 'nat 1-2' : 'nat 1-3'));
        }
        rows.push(w);
        if (d.weaponAttachments?.length) {
            const mount: Cell[] = [L('  └ ')];
            d.weaponAttachments.forEach((a, i) => {
                if (i) mount.push(L(` ${g.sep} `));
                mount.push(L(`${a.slot}: `), V(a.name));
            });
            rows.push(mount);
        }
    }
    const conds = (d.conditions ?? []).map(c => typeof c === 'string' ? c : `${c.name}${c.duration ? ` (${c.duration}d)` : ''}`);
    rows.push([L('WOUNDS: '), conds.length ? V(conds.join(` ${g.sep} `)) : L('none')]);
    if (d.effects?.length) rows.push([L('EFFECTS: '), V(d.effects.join(` ${g.sep} `))]);
    const tail: Cell[] = [];
    if (typeof d.gold === 'number') tail.push(L(`${d.currencyLabel ?? 'RU'} `), V(d.gold));
    if (d.weather) tail.push(L(tail.length ? `   ${g.sep} ` : ''), L('WEATHER '), V(d.weather));
    if (tail.length) rows.push(tail);
    return framed(out, emit(rows));
}

// ── honest fallback — an unknown actionType can never render empty ───
export function renderDefault(p: { message?: string; actionType?: string }): string {
    const rows: Cell[][] = [];
    if (p.actionType) rows.push([L('OUTPUT '), L(G().sep + ' '), V(p.actionType)]);
    rows.push([V(p.message && p.message.length ? p.message : '(no message in payload)')]);
    return emit(rows);
}

// ── КОНТАКТ / CONTACT — the gunfight (Wave B, FINDINGS #63) ────────────
// Rebuilt from the #38 actionResult envelope — the natural die ALWAYS
// prints, hit or miss, because the jam law reads it off the banner.
export interface ContactInput {
    actorName?: string; targetName?: string;
    die?: number; allRolls?: number[]; bonus?: number; total?: number;
    targetAc?: number; hit?: boolean; crit?: boolean;
    damageTotal?: number; damageType?: string; damageRolls?: number[];
    damageModifier?: 'immune' | 'resistant' | 'vulnerable';
    jamCheckOwed?: { weapon?: string; condition?: number; jamsOn?: string };
    hpBefore?: number; hpAfter?: number; defeated?: boolean;
    /** The GM resolved the attack at the table; the engine rolled no d20. */
    resolved?: 'hit' | 'crit' | 'miss';
}
export function renderContact(c: ContactInput): string {
    const g = G();
    // #66-B: OUTCOME TOKEN on attacks — ⚡/💀 fire on the engine's crit flag
    // and the natural 1; the bold line keeps HIT/MISS so the verdict stays
    // whole when the token is the crit lane.
    const margin = (typeof c.total === 'number' && typeof c.targetAc === 'number') ? c.total - c.targetAc : undefined;
    const summary = c.resolved
        ? `ATTACK ${g.sep} ${callsign(c.actorName ?? '???')} ${plain() ? '->' : '→'} ${callsign(c.targetName ?? '???')} ${g.sep} GM RESULT`
        : `ATTACK ${g.sep} ${callsign(c.actorName ?? '???')} ${plain() ? '->' : '→'} ${callsign(c.targetName ?? '???')} ${g.sep} ${c.total ?? '?'} vs AC ${c.targetAc ?? '?'}${margin !== undefined ? ` ${g.sep} by ${margin >= 0 ? '+' : ''}${margin}` : ''}`;
    const token = c.crit ? '⚡ CRITICAL' : c.die === 1 ? '💀 FUMBLE' : c.hit ? `${g.pass} HIT` : `${g.fail} MISS`;
    const head = outcomeHead(token, (c.crit || c.die === 1) ? `${summary} ${g.sep} ${c.hit ? 'HIT' : 'MISS'}` : summary, c.hit ? 'good' : 'bad');
    const rows: Cell[][] = [];
    const sign = (c.bonus ?? 0) >= 0 ? '+' : '';
    rows.push(c.resolved
        ? [
            V(callsign(c.actorName ?? '???')), L(' → '), V(callsign(c.targetName ?? '???')),
            L('   GM RESULT '), V(c.resolved.toUpperCase()), L('   no engine d20')
        ]
        : [
            V(callsign(c.actorName ?? '???')), L(' → '), V(callsign(c.targetName ?? '???')),
            L('   d20['), V(c.die ?? '?'), L('] '), V(`${sign}${c.bonus ?? 0}`), L(' → '), V(c.total ?? '?'),
            L('   AC '), V(c.targetAc ?? '?'), L('   '),
            V(c.hit ? `${g.pass} HIT` : `${g.fail} MISS`)
        ]);
    if (c.crit) rows.push([V(`${g.nat20} CRIT`)]);
    if (c.die === 1) rows.push([V(`${g.nat1} NAT 1`)]);
    if (c.jamCheckOwed)
        rows.push([V(`${g.warn} JAM CHECK OWED`), L(' — '), V(c.jamCheckOwed.weapon ?? '???'), L(' cond '), V(c.jamCheckOwed.condition ?? '?'), L(` ${g.sep} jams on `), V(c.jamCheckOwed.jamsOn ?? '?')]);
    if (Array.isArray(c.allRolls) && c.allRolls.length > 1)
        rows.push([L('─ dice '), V(c.allRolls.join(', ')), L(' '), L(g.sep + ' kept '), V(c.die ?? '?')]);
    if (c.hit && typeof c.damageTotal === 'number') {
        const dmg: Cell[] = [L(g.dmg + ' '), V(c.damageTotal)];
        // #63-b (Tom's catch): the individual damage dice print — die-step
        // verification (AP/expanding ammo) needs them on the glass, not
        // only in the JSON.
        if (Array.isArray(c.damageRolls) && c.damageRolls.length)
            dmg.push(L(' ['), V(c.damageRolls.join(', ')), L(']'));
        dmg.push(L(' '), V(c.damageType ?? ''));
        // HIGH-002: the total is already halved/doubled/zeroed — say so, or
        // the dice above it do not add up on the glass.
        if (c.damageModifier)
            dmg.push(L(` ${g.sep} `), V(c.damageModifier === 'immune' ? 'IMMUNE (no damage)'
                : c.damageModifier === 'resistant' ? 'RESISTANT (halved)' : 'VULNERABLE (doubled)'));
        if (typeof c.hpBefore === 'number' && typeof c.hpAfter === 'number')
            dmg.push(L('         '), V(callsign(c.targetName ?? '???')), L(' '), V(c.hpBefore), L(` ${g.to} `), V(c.hpAfter));
        rows.push(dmg);
    }
    if (c.defeated) rows.push([V(`${g.death} ${callsign(c.targetName ?? '???')} DOWN`)]);
    return head + emit(rows);
}

// ── СМЕРТЬ / DEATH'S DOOR — pips, and the flatline (Wave B) ────────────
export function renderDeath(p: { characterName?: string; roll?: number; natural?: number; successes?: number; failures?: number; dead?: boolean; stabilized?: boolean; message?: string }): string {
    const g = G();
    const rows: Cell[][] = [[L(g.death + ' '), L('DEATH SAVE')]];
    const nat = p.natural ?? p.roll;
    if (typeof nat === 'number') {
        rows.push([V(callsign(p.characterName ?? '???')), L('    d20['), V(nat), L('] '),
            V(nat >= 10 ? `${g.pass} PASS` : `${g.fail} FAIL`)]);
    } else if (p.message) {
        rows.push([V(p.message)]);
    }
    if ((p as { isNat20?: boolean }).isNat20) rows.push([V(`${g.nat20} NAT 20 — 1 HP, conscious`)]);
    if ((p as { isNat1?: boolean }).isNat1) rows.push([V(`${g.nat1} NAT 1 — counts twice`)]);
    if (typeof p.successes === 'number' || typeof p.failures === 'number') {
        const s = Math.max(0, Math.min(3, p.successes ?? 0));
        const f = Math.max(0, Math.min(3, p.failures ?? 0));
        rows.push([L('alive '), V(g.pipLive.repeat(s) + g.pipEmpty.repeat(3 - s)),
            L('   dead '), V(g.pipDead.repeat(f) + g.pipEmpty.repeat(3 - f))]);
    }
    if (p.stabilized) rows.push([V(`${g.pass} STABILIZED`)]);
    if (p.dead || (p.failures ?? 0) >= 3) {
        // The flatline rule: one full-width line — the one output in the
        // system allowed to be quiet.
        rows.push([V(`${g.pipDead}${g.pipDead}${g.pipDead}`), L('  ──────────────────────────  '), V('DEAD')]);
    }
    return emit(rows);
}

// ── ЧАСЫ / CLOCK — the mend-clock boot processor (Wave B) ──────────────
export function renderClock(p: { currentDay?: number; firedCount?: number; results?: Array<{ characterName?: string; firesAtDay?: number; note?: string | null; applied?: string[]; skipped?: string }>; message?: string }): string {
    const g = G();
    const rows: Cell[][] = [[L('CLOCK '), L(g.sep + ' DAY '), V(p.currentDay ?? '?')]];
    const results = Array.isArray(p.results) ? p.results : [];
    if (!results.length) {
        rows.push([L('nothing due')]);
        return emit(rows);
    }
    for (const r of results) {
        rows.push([V(callsign(r.characterName ?? '(deleted)')), L('   due D'), V(r.firesAtDay ?? '?'),
            ...(r.note ? [L('   ' + g.sep + ' '), L(r.note)] : [])]);
        if (r.skipped) rows.push([V(`${g.warn} ${r.skipped}`)]);
        for (const a of r.applied ?? []) {
            // The processor's applied strings carry raw pool figures — the psi
            // guard holds HERE too: hidden-pool lines render as accepted entries.
            rows.push(/\bpsi\b/i.test(a) ? [L('  entry accepted')] : [L('  '), V(a)]);
        }
    }
    return emit(rows);
}

// ── BENCH — weapon condition writes (Wave B) ────────────────────────────
export function renderBench(p: { weapon?: string; before?: number; current?: number; max?: number; clamped?: boolean; instanceCreated?: boolean; instanceId?: string }): string {
    const g = G();
    const rows: Cell[][] = [[L('BENCH '), L(g.sep + ' '), V(p.weapon ?? '???')]];
    const row: Cell[] = [L('cond '), V(p.before ?? '?'), L(` ${g.to} `), V(p.current ?? '?'),
        L('   ceiling '), V(p.max ?? 100)];
    if (p.clamped) row.push(L('  [clamped]'));
    rows.push(row);
    if (typeof p.current === 'number')
        rows.push([V(bar(p.current, 10, 100)), L('  jam risk: '), V(p.current >= 75 ? 'low' : p.current >= 50 ? 'nat 1' : p.current >= 25 ? 'nat 1-2' : 'nat 1-3')]);
    if (p.instanceCreated && p.instanceId)
        rows.push([L('instance born — this one is a specific gun: '), V(p.instanceId)]);
    return emit(rows);
}
