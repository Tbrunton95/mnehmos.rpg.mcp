/**
 * The one resistance rule (5e): immunity first (0), then resistance (half,
 * rounded down), then vulnerability (double). No damage type means no
 * modifier. Tokens and sheets both carry the three lists, so the encounter
 * engine and the no-encounter damage lane read the same function.
 */
export type DamageModifier = 'immune' | 'resistant' | 'vulnerable' | 'normal';

export interface DamageDefences {
    immunities?: string[] | null;
    resistances?: string[] | null;
    vulnerabilities?: string[] | null;
}

export function damageWithModifiers(baseDamage: number, damageType: string | undefined | null, target: DamageDefences): { finalDamage: number; modifier: DamageModifier } {
    if (!damageType) return { finalDamage: baseDamage, modifier: 'normal' };
    const typeLC = damageType.toLowerCase();
    const has = (list?: string[] | null) => (list ?? []).some(x => String(x).toLowerCase() === typeLC);
    if (has(target.immunities)) return { finalDamage: 0, modifier: 'immune' };
    if (has(target.resistances)) return { finalDamage: Math.floor(baseDamage / 2), modifier: 'resistant' };
    if (has(target.vulnerabilities)) return { finalDamage: baseDamage * 2, modifier: 'vulnerable' };
    return { finalDamage: baseDamage, modifier: 'normal' };
}
