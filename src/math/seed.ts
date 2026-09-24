import { randomBytes } from 'node:crypto';

let counter = 0;

/**
 * A seed that never repeats in this process, for rolls the caller did not seed.
 * Time alone collided: every roll made in the same millisecond (batch_manage
 * execute_sequence) replayed identical dice. An explicit caller seed is still
 * used verbatim elsewhere, so seeded rolls stay replayable; echo the seed that
 * was used so an unseeded roll can be replayed too.
 */
export function freshSeed(tag = 'roll'): string {
    counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
    return `${tag}-${Date.now().toString(36)}-${counter.toString(36)}-${randomBytes(4).toString('hex')}`;
}
