import { replyJson, replyOutcome, splitOpLine } from '../../src/server/reply-status.js';

const reply = (text: string, isError?: boolean) => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });
const embed = (data: unknown) => `BANNER\n<!-- X_JSON\n${JSON.stringify(data)}\nX_JSON -->\n`;

/**
 * Play report 2, #11: the guard read only `error: true`. Router validation and
 * unknown-action replies carry a string error code, so they were committed and
 * their opId was stored as applied; the corrected retry was then refused.
 */
describe('replyOutcome', () => {
    it('reads a boolean or a string error, bare or embedded, as an error', () => {
        expect(replyOutcome(reply('{"error":true,"message":"x"}'))).toBe('error');
        expect(replyOutcome(reply('{"error":"validation_error","writes":"none"}'))).toBe('error');
        expect(replyOutcome(reply(embed({ error: 'invalid_action', suggestions: [] })))).toBe('error');
        expect(replyOutcome(reply(embed({ error: true })))).toBe('error');
    });

    it('reads the MCP isError flag as an error whatever the text says', () => {
        expect(replyOutcome(reply('{"success":true}', true))).toBe('error');
        expect(replyOutcome(reply('all good', true))).toBe('error');
    });

    it('does not read a nested error, an empty error or success:false as an error', () => {
        expect(replyOutcome(reply(embed({ success: true, clock: { error: 'no clock' } })))).toBe('applied');
        expect(replyOutcome(reply(embed({ success: true, error: '' })))).toBe('applied');
        // A partly failed batch, a defeated mover, a failed arcana check: all wrote.
        expect(replyOutcome(reply(embed({ success: false, message: 'step 2 failed' })))).toBe('applied');
    });

    it('reads writes:none as no_write, and an error with writes:none still as an error', () => {
        expect(replyOutcome(reply(embed({ success: true, preview: true, writes: 'none' })))).toBe('no_write');
        expect(replyOutcome(reply(embed({ error: 'validation_error', writes: 'none' })))).toBe('error');
    });

    it('treats prose, an empty reply and unparsable JSON as applied', () => {
        expect(replyOutcome(reply('Just words'))).toBe('applied');
        expect(replyOutcome(reply('{not json'))).toBe('applied');
        expect(replyOutcome({ content: [] })).toBe('applied');
        expect(replyOutcome(undefined)).toBe('applied');
    });
});

describe('replyJson and the op line', () => {
    it('finds the embed behind a leading guard line, and bare JSON', () => {
        expect(replyJson(`▌ op v1 applied\n${embed({ a: 1 })}`)).toEqual({ a: 1 });
        expect(replyJson('{"a":2}')).toEqual({ a: 2 });
        expect(replyJson('▌ op v1 applied\n{"a":3}')).toEqual({ a: 3 });
        expect(replyJson('[1,2]')).toBeNull();
        expect(replyJson(undefined)).toBeNull();
    });

    it('lifts only the guard\'s own first line, never a tool\'s rail line', () => {
        expect(splitOpLine('▌ op v1 applied\nBODY')).toEqual({ op: 'op v1 applied', rest: 'BODY' });
        expect(splitOpLine('▌ ↺ REPLAYED op v1: already applied at t; nothing applied again.\nBODY').op).toMatch(/^↺ REPLAYED op v1/);
        expect(splitOpLine('▌ ✖ REFUSED — opId v1 was already used\nBODY').op).toMatch(/^✖ REFUSED/);
        expect(splitOpLine('▌ op v1 NOT applied (error) — opId still free\nBODY').op).toMatch(/NOT applied/);
        expect(splitOpLine('▌ HP 320/320 · RESOLVE 100/100\n▌ COND x\n')).toEqual({ rest: '▌ HP 320/320 · RESOLVE 100/100\n▌ COND x\n' });
        expect(splitOpLine('plain')).toEqual({ rest: 'plain' });
    });
});
