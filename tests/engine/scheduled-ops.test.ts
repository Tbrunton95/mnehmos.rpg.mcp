import { applyScheduledOps, scheduledWriteOpSchema, scheduledOpMissing } from '../../src/engine/scheduled-ops.js';

/**
 * Play report 6 #3: the scheduled grammar reaches body parts. set_part and
 * remove_part write the sheet's parts through the same merge rules as the
 * token handler and come back in partOps for the commit step to replay onto
 * live tokens. A clock cannot latch (it has no participant to hold).
 */
const sheet = (parts?: unknown[]) => ({ hp: 10, maxHp: 10, ...(parts ? { parts } : {}) }) as any;
const arm = { name: 'left arm', kind: 'arm', state: 'crippled', holds: ['claw'], ac: 15 };

describe('scheduled part ops: grammar', () => {
    it('set_part and remove_part join the op enum with the part fields; latched and an unknown state are refused', () => {
        const s = scheduledWriteOpSchema();
        const full = { op: 'set_part', part: 'left arm', state: 'intact', kind: 'arm', holds: ['claw'], ac: 15, hp: 4, maxHp: 8, breakAt: 10, note: 'healed' };
        expect(s.parse(full)).toEqual(full);
        expect(s.parse({ op: 'remove_part', part: 'tail' })).toEqual({ op: 'remove_part', part: 'tail' });
        expect(s.safeParse({ op: 'set_part', part: 'jaw', state: 'latched' }).success).toBe(false);
        expect(s.safeParse({ op: 'set_part', part: 'jaw', state: 'broken' }).success).toBe(false);
        expect(s.safeParse({ op: 'set_part', part: 'jaw', state: 'intact', kind: 'tentacle' }).success).toBe(false);
        // The old ops are untouched.
        expect(s.parse({ op: 'adjust_hp', delta: -3 })).toEqual({ op: 'adjust_hp', delta: -3 });
    });
});

describe('scheduled part ops: applyScheduledOps', () => {
    it('set_part on a sheet part changes its state and keeps holds and ac; the line, updates.parts and partOps say so', () => {
        const op = { op: 'set_part' as const, part: 'left arm', state: 'intact' as const };
        const r = applyScheduledOps(sheet([arm]), [op]);
        expect(r.applied).toEqual(['set_part: left arm crippled → intact (sheet)']);
        expect(r.updates).toEqual({ parts: [{ name: 'left arm', kind: 'arm', state: 'intact', holds: ['claw'], ac: 15 }] });
        expect(r.partOps).toEqual([{ op, line: 0 }]);
    });

    it('set_part on a part the sheet lacks adds it, kind other unless given; a sheet with no parts at all works', () => {
        const r = applyScheduledOps(sheet([arm]), [{ op: 'set_part', part: 'tail', state: 'crippled' }]);
        expect(r.applied).toEqual(['set_part: tail → crippled (new part on sheet)']);
        expect(r.updates.parts).toEqual([arm, { name: 'tail', kind: 'other', state: 'crippled' }]);
        const bare = applyScheduledOps(sheet(), [{ op: 'set_part', part: 'left wing', state: 'crippled', kind: 'wing', hp: 6 }]);
        expect(bare.updates.parts).toEqual([{ name: 'left wing', kind: 'wing', state: 'crippled', hp: 6, maxHp: 6 }]);
    });

    it('remove_part takes the part off; a name not on the sheet is skipped and nothing is written, but the op still replays onto tokens', () => {
        const r = applyScheduledOps(sheet([arm, { name: 'tail', kind: 'other', state: 'intact' }]), [{ op: 'remove_part', part: 'Tail' }]);
        expect(r.applied).toEqual(['−part tail (sheet)']);
        expect(r.updates.parts).toEqual([arm]);
        expect(r.partOps).toEqual([{ op: { op: 'remove_part', part: 'Tail' }, line: 0 }]);
        const miss = applyScheduledOps(sheet([arm]), [{ op: 'remove_part', part: 'horn' }]);
        expect(miss.applied).toEqual(['part "horn" not present on sheet — skipped']);
        expect(miss.updates).toEqual({});
        expect(miss.partOps).toEqual([{ op: { op: 'remove_part', part: 'horn' }, line: 0 }]);
    });

    it('latched cannot be scheduled: a skipped line, nothing written, nothing replayed', () => {
        const r = applyScheduledOps(sheet([arm]), [{ op: 'set_part', part: 'left arm', state: 'latched' } as any]);
        expect(r.applied).toHaveLength(1);
        expect(r.applied[0]).toMatch(/^⚠ set_part left arm: latched cannot be scheduled .*skipped$/);
        expect(r.updates).toEqual({});
        expect(r.partOps).toEqual([]);
    });

    it('a part op without a name or a state is skipped and says which', () => {
        const r = applyScheduledOps(sheet([arm]), [{ op: 'set_part', state: 'intact' } as any, { op: 'set_part', part: 'left arm' } as any, { op: 'remove_part' } as any]);
        expect(r.applied).toEqual(['⚠ set_part op missing part name — skipped', '⚠ set_part op missing state — skipped', '⚠ remove_part op missing part name — skipped']);
        expect(r.updates).toEqual({});
        expect(r.partOps).toEqual([]);
    });

    it('part ops ride beside the old ops in order; partOps point at their own lines', () => {
        const r = applyScheduledOps(sheet([arm]), [{ op: 'adjust_hp', delta: -4 }, { op: 'set_part', part: 'left arm', state: 'intact' }, { op: 'add_condition', name: 'sore' }]);
        expect(r.applied).toEqual(['hp: 10 → 6', 'set_part: left arm crippled → intact (sheet)', '+condition sore']);
        expect(r.updates).toMatchObject({ hp: 6, parts: [expect.objectContaining({ state: 'intact' })], conditions: [expect.objectContaining({ name: 'sore' })] });
        expect(r.partOps).toEqual([{ op: { op: 'set_part', part: 'left arm', state: 'intact' }, line: 1 }]);
    });

    it('the old ops still return no partOps', () => {
        expect(applyScheduledOps(sheet(), [{ op: 'adjust_hp', delta: -1 }]).partOps).toEqual([]);
    });
});

describe('scheduled part ops beside a note (play report 6 #2 + #3)', () => {
    it('a note that prints two lines before a set_part leaves partOps pointing at the part line', () => {
        const r = applyScheduledOps(sheet([arm]), [{ op: 'note', text: 'adjust_hp -3' }, { op: 'set_part', part: 'left arm', state: 'intact' }, { op: 'note', text: 'the arm has healed' }]);
        expect(r.applied).toHaveLength(4);
        expect(r.applied[0]).toBe('note: adjust_hp -3');
        expect(r.applied[1]).toMatch(/^⚠ 'adjust_hp -3' reads like an op/);
        expect(r.applied[2]).toBe('set_part: left arm crippled → intact (sheet)');
        expect(r.applied[3]).toBe('note: the arm has healed');
        expect(r.partOps).toEqual([{ op: { op: 'set_part', part: 'left arm', state: 'intact' }, line: 2 }]);
        expect(r.updates).toEqual({ parts: [{ ...arm, state: 'intact' }] });
    });

    it('a blank part name is skipped like a missing one: no nameless part on the sheet, nothing to replay', () => {
        const r = applyScheduledOps(sheet([arm]), [{ op: 'set_part', part: '   ', state: 'intact' }, { op: 'remove_part', part: ' ' }]);
        expect(r.applied).toEqual(['⚠ set_part op missing part name — skipped', '⚠ remove_part op missing part name — skipped']);
        expect(r.updates).toEqual({});
        expect(r.partOps).toEqual([]);
    });
});

describe('scheduledOpMissing: what a clock must carry to do anything when it fires', () => {
    it('names the field an op lacks, and nothing for a complete op', () => {
        expect(scheduledOpMissing({ op: 'set_part', part: 'left arm' } as any)).toMatch(/set_part.*state/);
        expect(scheduledOpMissing({ op: 'set_part', state: 'intact' } as any)).toMatch(/set_part.*part/);
        expect(scheduledOpMissing({ op: 'set_part', part: '  ', state: 'intact' } as any)).toMatch(/set_part.*part/);
        expect(scheduledOpMissing({ op: 'remove_part' } as any)).toMatch(/remove_part.*part/);
        expect(scheduledOpMissing({ op: 'adjust_pool', delta: -1 } as any)).toMatch(/adjust_pool.*pool/);
        expect(scheduledOpMissing({ op: 'add_condition' } as any)).toMatch(/add_condition.*name/);
        expect(scheduledOpMissing({ op: 'remove_condition' } as any)).toMatch(/remove_condition.*name/);
        expect(scheduledOpMissing({ op: 'note' } as any)).toMatch(/note.*text/);
        for (const ok of [
            { op: 'set_part', part: 'left arm', state: 'intact' }, { op: 'remove_part', part: 'tail' }, { op: 'adjust_pool', pool: 'grit', delta: -1 },
            { op: 'adjust_hp', delta: -1 }, { op: 'adjust_hp' }, { op: 'adjust_max_hp', delta: 2 }, { op: 'add_condition', name: 'sore' }, { op: 'remove_condition', name: 'sore' }, { op: 'note', text: 'healed' }
        ]) expect(scheduledOpMissing(ok as any)).toBeUndefined();
    });
});
