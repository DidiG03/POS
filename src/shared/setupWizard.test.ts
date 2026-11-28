import { describe, expect, it } from 'vitest';
import {
  advanceSetup,
  goToSetupStep,
  readSetupProgress,
  setupChecklist,
  setupWizardShouldOpen,
} from './setupWizard';
import { MENU_CSV_TEMPLATE, parseCsv, validateMenuCsv } from './menuCsv';

describe('setup wizard progress', () => {
  it('starts at business details on a fresh till', () => {
    expect(readSetupProgress({})).toEqual({ current: 'business', steps: {} });
    expect(setupWizardShouldOpen({})).toBe(true);
    expect(setupWizardShouldOpen({ restaurantName: 'OneTap POS' })).toBe(true);
  });

  it('saves each step and resumes where it was closed', () => {
    const now = new Date('2026-11-28T10:00:00Z');
    let p = readSetupProgress({});
    p = advanceSetup(p, 'business', 'done', now);
    p = advanceSetup(p, 'fiscal', 'skipped', now);
    // Saved as settings, read back after the window was closed:
    const reopened = readSetupProgress({
      setupWizard: JSON.parse(JSON.stringify(p)),
    });
    expect(reopened.current).toBe('printers');
    expect(reopened.steps).toEqual({ business: 'done', fiscal: 'skipped' });
    // Once a business exists it still reopens until finished.
    expect(
      setupWizardShouldOpen({ restaurantName: 'Bar Lula', setupWizard: p }),
    ).toBe(true);
    // Going back keeps what was done.
    expect(goToSetupStep(reopened, 'business').steps.fiscal).toBe('skipped');
  });

  it('stops opening by itself once finished or dismissed, or on a set-up till', () => {
    let p = readSetupProgress({});
    for (const s of [
      'business',
      'fiscal',
      'printers',
      'menu',
      'staff',
      'devices',
      'finish',
    ] as const) {
      p = advanceSetup(p, s, 'done');
    }
    expect(p.finishedAt).toBeTruthy();
    expect(setupWizardShouldOpen({ setupWizard: p })).toBe(false);
    expect(setupWizardShouldOpen({ setupWizard: { dismissed: true } })).toBe(
      false,
    );
    expect(setupWizardShouldOpen({ restaurantName: 'Bar Lula' })).toBe(false);
    // Junk in settings never breaks it.
    expect(
      readSetupProgress({
        setupWizard: { current: 'nope', steps: { x: 'done', menu: 'maybe' } },
      }),
    ).toEqual({
      current: 'business',
      steps: {},
    });
  });

  it('the finish checklist says what is missing', () => {
    const list = setupChecklist({
      businessName: 'Bar Lula',
      address: 'Rruga 1',
      country: 'AL',
      fiscalEnabled: true,
      fiscalTested: false,
      printers: 1,
      testPrinted: 0,
      menuItems: 0,
      staff: 1,
      admins: 1,
      pairingCode: true,
    });
    const by = Object.fromEntries(list.map((l) => [l.key, l]));
    expect(by.business.ok).toBe(true);
    expect(by.fiscal).toMatchObject({ ok: false, detail: 'Not tested yet' });
    expect(by.printers.ok).toBe(false);
    expect(by.menu.detail).toBe('No menu items yet');
    expect(by.staff.detail).toBe('No waiters yet');
    expect(
      setupChecklist({
        ...(list as any),
        businessName: 'X',
        address: 'Y',
        country: 'UK',
        fiscalEnabled: false,
        fiscalTested: false,
        printers: 0,
        testPrinted: 0,
        menuItems: 0,
        staff: 0,
        admins: 0,
        pairingCode: false,
      })[1],
    ).toMatchObject({ ok: true, detail: 'Not needed' });
  });
});

describe('menu CSV', () => {
  it('the template itself imports cleanly', () => {
    const r = validateMenuCsv(MENU_CSV_TEMPLATE);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(5);
    expect(r.rows[3]).toMatchObject({
      name: 'Burger, fries',
      price: 9,
      vatRate: 0.2,
      station: 'KITCHEN',
    });
  });

  it('reads quotes, semicolons, comma decimals and a BOM', () => {
    expect(parseCsv('﻿a;"b ""x"", c";3\r\n')).toEqual([['a', 'b "x", c', '3']]);
    const r = validateMenuCsv(
      'category;name;price;vat_rate;station\nFood;Soup;"4,50";6%;kitchen\n',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({
      price: 4.5,
      vatRate: 0.06,
      station: 'KITCHEN',
    });
  });

  it('reports every problem by line and column, and imports nothing', () => {
    const csv = [
      'category,name,price,vat_rate,station',
      'Drinks,Espresso,1.50,20,BAR',
      ',Latte,2,20,BAR',
      'Drinks,Tea,two,20,BAR',
      'Drinks,Juice,-1,20,BAR',
      'Drinks,Beer,3,17,BAR',
      'Drinks,Wine,4,20,CELLAR',
      'Drinks,Espresso,1.60,20,BAR',
      '',
    ].join('\n');
    const r = validateMenuCsv(csv);
    expect(r.rows).toEqual([]);
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([
      [3, 'category'],
      [4, 'price'],
      [5, 'price'],
      [6, 'vat_rate'],
      [7, 'station'],
      [8, 'name'],
    ]);
    expect(r.errors[5].message).toMatch(/already on line 2/);
  });

  it('a missing column or an empty file is one clear error', () => {
    expect(validateMenuCsv('name,price\nTea,2').errors[0].message).toMatch(
      /no "category" column/,
    );
    expect(validateMenuCsv('').errors[0].message).toMatch(/empty/);
    expect(validateMenuCsv('category,name,price\n').errors[0].message).toMatch(
      /no menu rows/,
    );
  });
});

import {
  businessStepErrors,
  EASYPOS_DEMO_URL,
  fiscalStepErrors,
  printerStepErrors,
} from './setupWizard';
import { importMenuCsvRows } from '../renderer/utils/menuCsvImport';

describe('step checks', () => {
  it('business: clear errors for each field', () => {
    expect(
      businessStepErrors({
        name: 'Bar Lula',
        address: 'Rruga e Kavajës 1, Tiranë',
        country: 'AL',
        currency: 'ALL',
        taxId: 'L12345678A',
      }),
    ).toEqual({});
    const e = businessStepErrors({
      name: 'B',
      address: 'x',
      country: '',
      currency: 'GBP',
      taxId: '',
    });
    expect(Object.keys(e).sort()).toEqual(['address', 'country', 'name']);
    expect(
      businessStepErrors({
        name: 'Bar',
        address: 'Rruga 1, Tiranë',
        country: 'AL',
        currency: 'GBP',
        taxId: 'L1',
      }),
    ).toMatchObject({
      currency: expect.stringMatching(/ALL or EUR/),
      taxId: expect.stringMatching(/NIPT/),
    });
    expect(
      businessStepErrors({
        name: 'The Pub',
        address: '1 High St, Bath',
        country: 'UK',
        currency: 'GBP',
        taxId: '',
      }),
    ).toEqual({});
  });

  it('fiscal: only the DEMO service during setup', () => {
    const ok = {
      baseUrl: EASYPOS_DEMO_URL,
      authToken: 'jwt',
      tokenSaved: false,
      operatorCode: 'ab123cd456',
      integrationApp: 'generic',
    };
    expect(fiscalStepErrors(ok)).toEqual({});
    expect(
      fiscalStepErrors({
        ...ok,
        baseUrl: 'https://api.easypos.al/fiscalisation-service/v1',
      }).baseUrl,
    ).toMatch(/DEMO/);
    expect(
      fiscalStepErrors({ ...ok, authToken: '', tokenSaved: true }),
    ).toEqual({});
    expect(
      fiscalStepErrors({ ...ok, operatorCode: 'abc' }).operatorCode,
    ).toBeTruthy();
  });

  it('printers: address and port', () => {
    expect(
      printerStepErrors({ name: 'Kitchen', ip: '192.168.1.50', port: '9100' }),
    ).toEqual({});
    expect(printerStepErrors({ name: '', ip: '300.1.1.1', port: '0' })).toEqual(
      {
        name: expect.any(String),
        ip: expect.stringMatching(/not a network address/),
        port: expect.any(String),
      },
    );
  });
});

describe('importing the menu CSV', () => {
  it('creates categories then items, skips what exists, reports failures by line', async () => {
    const made: string[] = [];
    let nextId = 10;
    const api = {
      listCategoriesWithItems: async () => [
        { id: 1, name: 'Drinks', items: [{ id: 5, name: 'Espresso' }] },
      ],
      createCategory: async ({ name }: any) => {
        made.push(`cat:${name}`);
        return { id: nextId++ };
      },
      createItem: async ({ name }: any) => {
        if (name === 'Bad') throw new Error('refused');
        made.push(`item:${name}`);
        return {};
      },
    };
    const rows = validateMenuCsv(
      'category,name,price,vat_rate,station\nDrinks,Espresso,1.5,20,BAR\nDrinks,Tea,2,20,BAR\nFood,Soup,4,6,KITCHEN\nFood,Bad,1,20,KITCHEN\n',
    ).rows;
    const r = await importMenuCsvRows(rows, api);
    expect(r).toEqual({
      categories: 1,
      created: 2,
      existing: 1,
      failed: [{ line: 5, message: '"Bad": refused' }],
    });
    expect(made).toEqual(['item:Tea', 'cat:Food', 'item:Soup']);
  });
});
