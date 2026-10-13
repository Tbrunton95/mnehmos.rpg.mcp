/**
 * Play report 5 #7: custom armour. One armour module reads every spelling a
 * GM has used for an armour template (baseAc, base_ac, ac, armorClass,
 * maxDex, category, armorType...), infers the DEX cap from the category when
 * no cap is written (heavy: none; medium: 2; light: full), composes the AC
 * from the worn set, and says so when an armour-slot item cannot be read
 * instead of falling back to unarmoured in silence. #8b: natural armour is
 * the floor the worn armour must beat; shields and other acBonus items add
 * on top of whichever wins.
 */
import {
    ARMOR_CATEGORIES, readArmorProps, canonicalArmorProps, dexCapFor, nearestArmorCategory, composeArmorClass
} from '../../src/engine/armor.js';

describe('readArmorProps: every spelling of the armour keys', () => {
    it('reads the canonical keys as written', () => {
        const p = readArmorProps({ baseAC: 14, armorCategory: 'medium', maxDexBonus: 2, strengthRequired: 13, stealthDisadvantage: true, acBonus: 1 });
        expect(p).toMatchObject({ baseAC: 14, armorCategory: 'medium', maxDexBonus: 2, strengthRequired: 13, stealthDisadvantage: true, acBonus: 1 });
        expect(p.aliased).toEqual({});
    });

    it("reads the GM's mail shirt {baseAc: 13, maxDexBonus: 2} and names the alias", () => {
        const p = readArmorProps({ baseAc: 13, maxDexBonus: 2 });
        expect(p.baseAC).toBe(13);
        expect(p.maxDexBonus).toBe(2);
        expect(p.aliased).toEqual({ baseAc: 'baseAC' });
    });

    it('is case- and underscore-insensitive: base_ac, BASEAC, armor_class, armorClass, legacy ac', () => {
        expect(readArmorProps({ base_ac: 12 }).baseAC).toBe(12);
        expect(readArmorProps({ BASEAC: 12 }).baseAC).toBe(12);
        expect(readArmorProps({ armor_class: 12 }).baseAC).toBe(12);
        expect(readArmorProps({ armorClass: 12 }).baseAC).toBe(12);
        expect(readArmorProps({ ac: 12 }).baseAC).toBe(12);
        expect(readArmorProps({ maxDex: 2 }).maxDexBonus).toBe(2);
        expect(readArmorProps({ max_dex_bonus: 2 }).maxDexBonus).toBe(2);
        expect(readArmorProps({ dexCap: 2 }).maxDexBonus).toBe(2);
        expect(readArmorProps({ strength_required: 15 }).strengthRequired).toBe(15);
        expect(readArmorProps({ strReq: 15 }).strengthRequired).toBe(15);
        expect(readArmorProps({ stealth_disadvantage: true }).stealthDisadvantage).toBe(true);
        expect(readArmorProps({ armorType: 'Heavy' }).armorCategory).toBe('heavy');
        expect(readArmorProps({ armor_type: 'light' }).armorCategory).toBe('light');
    });

    it('baseAC wins over a disagreeing legacy ac', () => {
        const p = readArmorProps({ baseAC: 14, ac: 13 });
        expect(p.baseAC).toBe(14);
    });

    it("SRD category: 'Armor' is not an armour category; category: 'Shield' is", () => {
        expect(readArmorProps({ category: 'Armor', armorCategory: 'medium' }).armorCategory).toBe('medium');
        expect(readArmorProps({ category: 'Armor' }).armorCategory).toBeUndefined();
        expect(readArmorProps({ category: 'Shield', acBonus: 2 }).armorCategory).toBe('shield');
        expect(readArmorProps({ category: 'light' }).armorCategory).toBe('light');
    });

    it('addDexterityModifier: false reads as no DEX', () => {
        expect(dexCapFor(readArmorProps({ baseAC: 16, addDexterityModifier: false }))).toBe(0);
    });
});

describe('dexCapFor: the DEX cap from the written cap, else the category', () => {
    it('a written maxDexBonus wins over the category', () => {
        expect(dexCapFor(readArmorProps({ baseAC: 13, armorCategory: 'heavy', maxDexBonus: 1 }))).toBe(1);
        expect(dexCapFor(readArmorProps({ baseAC: 13, maxDexBonus: 0 }))).toBe(0);
    });
    it('heavy: no DEX; medium: 2; light: full; unknown with nothing written: full', () => {
        expect(dexCapFor(readArmorProps({ baseAC: 16, armorCategory: 'heavy' }))).toBe(0);
        expect(dexCapFor(readArmorProps({ baseAC: 14, armorCategory: 'medium' }))).toBe(2);
        expect(dexCapFor(readArmorProps({ baseAC: 11, armorCategory: 'light' }))).toBe(Infinity);
        expect(dexCapFor(readArmorProps({ baseAC: 11 }))).toBe(Infinity);
    });
    it('legacy heavy armour: a strengthRequired with no cap means no DEX', () => {
        expect(dexCapFor(readArmorProps({ ac: 16, strengthRequired: 13 }))).toBe(0);
    });
});

describe('canonicalArmorProps: the write-side rewrite', () => {
    it('rewrites aliases to the canonical keys and reports them', () => {
        const r = canonicalArmorProps({ baseAc: 13, maxDex: 2, armorType: 'medium', colour: 'rust' });
        expect(r.problems).toEqual([]);
        expect(r.properties).toEqual({ baseAC: 13, maxDexBonus: 2, armorCategory: 'medium', colour: 'rust' });
        expect(r.aliased).toEqual({ baseAc: 'baseAC', maxDex: 'maxDexBonus', armorType: 'armorCategory' });
    });
    it('keeps a legacy ac beside baseAC when they agree, and leaves SRD rows alone', () => {
        const srd = { category: 'Armor', armorCategory: 'medium', ac: 14, baseAC: 14, addDexterityModifier: true, maxDexBonus: 2, stealthDisadvantage: false, equipSlots: ['armor'] };
        const r = canonicalArmorProps(srd);
        expect(r.problems).toEqual([]);
        expect(r.properties).toEqual(srd);
        expect(r.aliased).toEqual({});
    });
    it('refuses a non-integer base, a negative cap, two spellings that disagree, and a category typo with the nearest name', () => {
        expect(canonicalArmorProps({ baseAC: 'thirteen' }).problems[0]).toMatch(/baseAC must be a non-negative integer/);
        expect(canonicalArmorProps({ maxDexBonus: -1 }).problems[0]).toMatch(/maxDexBonus must be a non-negative integer/);
        expect(canonicalArmorProps({ baseAC: 14, base_ac: 13 }).problems[0]).toMatch(/baseAC 14 and base_ac 13 disagree/);
        const typo = canonicalArmorProps({ armorCategory: 'medum' });
        expect(typo.problems[0]).toMatch(/armorCategory 'medum' is not one of light, medium, heavy, shield/);
        expect(typo.problems[0]).toMatch(/nearest is 'medium'/);
    });
    it('nearestArmorCategory', () => {
        expect(nearestArmorCategory('medum')).toBe('medium');
        expect(nearestArmorCategory('hevy')).toBe('heavy');
        expect(nearestArmorCategory('plate')).toBeUndefined();
        expect([...ARMOR_CATEGORIES]).toEqual(['light', 'medium', 'heavy', 'shield']);
    });
});

describe('composeArmorClass: the worn set, natural armour and the warnings', () => {
    const dex12 = { dexMod: 1, strength: 14 };

    it("the GM's mail shirt {baseAc: 13, maxDexBonus: 2} on DEX 12 derives 14", () => {
        const r = composeArmorClass(dex12, [{ slot: 'armor', name: 'Mail shirt', properties: { baseAc: 13, maxDexBonus: 2 } }]);
        expect(r.ac).toBe(14);
        expect(r.parts[0]).toBe('Mail shirt base 13 + DEX(max 2)');
        expect(r.armor).toMatchObject({ item: 'Mail shirt', baseAC: 13, dexApplied: 1, dexCap: 2, aliased: { baseAc: 'baseAC' } });
        expect(r.warnings).toEqual([]);
    });

    it('heavy with no cap adds no DEX; medium with no cap is capped at 2; light takes it all', () => {
        const heavy = composeArmorClass({ dexMod: 3, strength: 15 }, [{ slot: 'armor', name: 'Plate', properties: { baseAC: 18, armorCategory: 'heavy' } }]);
        expect(heavy.ac).toBe(18);
        expect(heavy.parts[0]).toBe('Plate base 18 (no DEX)');
        const medium = composeArmorClass({ dexMod: 3, strength: 10 }, [{ slot: 'armor', name: 'Breastplate', properties: { baseAC: 14, armorCategory: 'medium' } }]);
        expect(medium.ac).toBe(16);
        const light = composeArmorClass({ dexMod: 3, strength: 10 }, [{ slot: 'armor', name: 'Leather', properties: { baseAC: 11, armorCategory: 'light' } }]);
        expect(light.ac).toBe(14);
        expect(light.parts[0]).toBe('Leather base 11 + DEX');
    });

    it('an armour-slot item with no readable base warns and prints the fix instead of falling back in silence', () => {
        const r = composeArmorClass(dex12, [{ slot: 'armor', itemId: 'shirt-1', name: 'Mail shirt', properties: { weightClass: 'medium' } }]);
        expect(r.ac).toBe(11);
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]).toContain('Mail shirt is worn in the armor slot but has no readable baseAC');
        expect(r.warnings[0]).toContain("item_manage update {itemId: 'shirt-1', properties: {baseAC: <n>}, mergeProperties: true}");
        expect(r.warnings[0]).toContain('AC fell back to unarmoured 10 + DEX');
    });

    it('a STR below the requirement notes the 5e speed penalty and does not apply it', () => {
        const r = composeArmorClass({ dexMod: 0, strength: 11 }, [{ slot: 'armor', name: 'Chain mail', properties: { baseAC: 16, armorCategory: 'heavy', strengthRequired: 13 } }]);
        expect(r.ac).toBe(16);
        expect(r.armor?.meetsStrength).toBe(false);
        expect(r.warnings[0]).toBe('STR 11 is below the 13 Chain mail requires: speed -10 ft (5e; not applied)');
    });

    it('acBonus items add on top: a shield in the offhand, a ring, magic armour', () => {
        const r = composeArmorClass(dex12, [
            { slot: 'armor', name: 'Mail +1', properties: { baseAC: 13, maxDexBonus: 2, acBonus: 1 } },
            { slot: 'offhand', name: 'Shield', properties: { armorCategory: 'shield', acBonus: 2 } },
            { slot: 'accessory', name: 'Ring', properties: { acBonus: 1 } }
        ]);
        expect(r.ac).toBe(18);
        expect(r.parts).toEqual(['Mail +1 base 13 + DEX(max 2)', 'Mail +1 +1', 'Shield +2', 'Ring +1']);
    });

    it('a legacy ac outside the armor slot is never a base', () => {
        const r = composeArmorClass(dex12, [{ slot: 'accessory', name: 'Odd ring', properties: { ac: 1 } }]);
        expect(r.ac).toBe(11);
        expect(r.parts).toEqual(['unarmored 10 + DEX +1']);
    });

    it('stealth disadvantage rides the worn armour', () => {
        const r = composeArmorClass(dex12, [{ slot: 'armor', name: 'Scale', properties: { baseAC: 14, armorCategory: 'medium', stealthDisadvantage: true } }]);
        expect(r.armor?.stealthDisadvantage).toBe(true);
    });

    // #8b natural armour.
    it('natural armour replaces the unarmoured base when higher: 12 + DEX at DEX +1 is 13', () => {
        const r = composeArmorClass({ ...dex12, naturalArmor: { base: 12, addDex: true } }, []);
        expect(r.ac).toBe(13);
        expect(r.parts).toEqual(['natural armour 12 + DEX +1']);
        expect(r.natural).toEqual({ base: 12, dexApplied: 1, ac: 13 });
    });

    it('worn armour must beat the natural armour: the mail shirt (14) beats natural 13; leather (12) loses to it', () => {
        const shirt = composeArmorClass({ ...dex12, naturalArmor: { base: 12, addDex: true } }, [{ slot: 'armor', name: 'Mail shirt', properties: { baseAC: 13, maxDexBonus: 2 } }]);
        expect(shirt.ac).toBe(14);
        expect(shirt.parts[0]).toBe('Mail shirt base 13 + DEX(max 2) (beats natural armour 13)');
        const leather = composeArmorClass({ ...dex12, naturalArmor: { base: 12, addDex: true } }, [{ slot: 'armor', name: 'Leather', properties: { baseAC: 11, armorCategory: 'light' } }]);
        expect(leather.ac).toBe(13);
        expect(leather.parts[0]).toBe('natural armour 12 + DEX +1 (beats Leather 12)');
    });

    it('a shield adds on top of natural armour; natural armour can cap or refuse DEX', () => {
        const r = composeArmorClass({ ...dex12, naturalArmor: { base: 12, addDex: true } }, [{ slot: 'offhand', name: 'Shield', properties: { armorCategory: 'shield', acBonus: 2 } }]);
        expect(r.ac).toBe(15);
        expect(composeArmorClass({ dexMod: 3, strength: 10, naturalArmor: { base: 15, addDex: false } }, []).ac).toBe(15);
        expect(composeArmorClass({ dexMod: 3, strength: 10, naturalArmor: { base: 12, addDex: true, maxDex: 2 } }, []).ac).toBe(14);
    });
});
