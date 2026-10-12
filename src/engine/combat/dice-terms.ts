/**
 * Dice notation terms, shared by the combat RNG and the crypto dice. Its own
 * module so crypto-dice.ts and rng.ts do not import each other: that cycle
 * left rng.ts bound to the real cryptoInt whenever a test mocked it.
 */
export type DiceTerm =
    | { kind: 'dice'; count: number; sides: number; sign: 1 | -1 }
    | { kind: 'scalar'; value: number; sign: 1 | -1 };

/**
 * Parse compound dice notation into a list of terms.
 * Accepts a `+`/`-`-joined chain of dice (`NdS`, `dS`) and integers.
 * Examples: `1d6+4+2d6`, `1d8+3+2d8`, `2d6+1d4-2`, `d20+5`.
 *
 * Strict grammar — rejects malformed operator chains like `1d6++2`,
 * `1d6--2`, `1d6+`, or trailing operators. Pattern:
 *   <term> ( [+-] <term> )*
 *   <term> := <int> | <int>?d<int>
 * with at most one leading sign.
 */
export function parseDiceTerms(notation: string): DiceTerm[] {
    const stripped = notation.replace(/\s+/g, '');
    if (!stripped) {
        throw new Error(`Invalid dice notation: ${notation}`);
    }
    const TERM = String.raw`(?:\d*d\d+|\d+)`;
    const STRICT = new RegExp(`^[+-]?${TERM}(?:[+-]${TERM})*$`, 'i');
    if (!STRICT.test(stripped)) {
        throw new Error(`Invalid dice notation: ${notation}`);
    }

    // Tokenize once the grammar check has passed.
    const tokens = stripped.match(/[+-]?[^+-]+/g)!;

    const terms: DiceTerm[] = [];
    for (const raw of tokens) {
        const sign: 1 | -1 = raw.startsWith('-') ? -1 : 1;
        const body = raw.replace(/^[+-]/, '');
        const diceMatch = body.match(/^(\d*)d(\d+)$/i);
        if (diceMatch) {
            const count = diceMatch[1] === '' ? 1 : parseInt(diceMatch[1], 10);
            const sides = parseInt(diceMatch[2], 10);
            if (count <= 0 || sides <= 0) {
                throw new Error(`Invalid dice notation: ${notation}`);
            }
            terms.push({ kind: 'dice', count, sides, sign });
            continue;
        }
        // Grammar already guaranteed scalar shape.
        terms.push({ kind: 'scalar', value: parseInt(body, 10), sign });
    }
    return terms;
}
