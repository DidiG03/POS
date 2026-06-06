/* eslint-disable no-console */
/*
 * Schema parity check between the local Electron Prisma schema (SQLite)
 * and the cloud server Prisma schema (Postgres).
 *
 *  - We deliberately keep the schemas separate (different providers,
 *    different tenancy models), so they will never be byte-for-byte
 *    identical.
 *  - But the *business data* on shared models MUST stay in sync, or
 *    the Electron app will hit `Unknown argument` errors at runtime
 *    (we shipped two of these today: `color`, `isKg`).
 *
 * What this script does:
 *  - Parses both schemas with a tiny Prisma block parser (no full
 *    grammar, just enough for `model X { ... }` and `enum X { ... }`).
 *  - For each model in `SHARED_MODELS`, compares scalar / enum fields.
 *  - Skips relation fields and the `business` / `businessId` tenancy
 *    columns that only exist server-side.
 *  - Allow-lists known intentional differences in `ALLOWED_*_ONLY`.
 *  - Exits with code 1 (and a clear diff) on any unexpected drift.
 *
 * Run via `pnpm db:check-parity` or in pre-commit / CI.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const LOCAL_SCHEMA = resolve(repoRoot, 'prisma/schema.prisma');
const SERVER_SCHEMA = resolve(repoRoot, 'server/prisma/schema.prisma');

// Models whose business data fields must stay in sync. Server-only
// auxiliary models (Business, BillingStatus enum, etc.) are intentionally
// not listed.
const SHARED_MODELS = [
  'User',
  'Category',
  'MenuItem',
  'ModifierGroup',
  'Modifier',
  'Table',
  'Order',
  'OrderItem',
  'OrderItemModifier',
  'Payment',
  'InventoryItem',
  'RecipeComponent',
  'DayShift',
  'PrintJob',
  'TicketRequest',
  'Area',
  'Covers',
  'TicketLog',
  'KdsDayCounter',
  'KdsOrder',
  'KdsTicket',
  'KdsTicketStation',
  'SyncState',
  'Notification',
] as const;

// Enums that must agree (values + ordering doesn't matter, set equality).
const SHARED_ENUMS = [
  'Role',
  'PrepStation',
  'KdsStationStatus',
  'OrderType',
  'OrderStatus',
  'PaymentMethod',
  'PrintType',
  'PrintStatus',
  'RequestStatus',
  'NotificationType',
] as const;

// Fields legitimately present only locally (Electron-only behavior).
const ALLOWED_LOCAL_ONLY: Record<string, string[]> = {
  User: ['twoFactorEnabled', 'twoFactorSecret'],
  // KDS prep-station routing is a LAN-only concern (the kitchen display
  // talks to the local POS host, not the cloud), so the field never syncs
  // to the multi-tenant Postgres schema.
  Category: ['kdsStation'],
  MenuItem: ['stockLevel', 'stockRemaining', 'stockDay'],
  // Printer-offline retry queue lives only on the LAN POS host (SQLite).
  PrintJob: ['attempts', 'lastError', 'nextAttemptAt', 'printerProfileId'],
};

// Enum values legitimately present only locally (server/cloud queue path differs).
const ALLOWED_ENUM_VALUES_LOCAL_ONLY: Record<string, Set<string>> = {
  PrintStatus: new Set(['RETRY']),
};

// Fields legitimately present only server-side.
const ALLOWED_SERVER_ONLY: Record<string, string[]> = {
  User: ['email'],
  // Server SyncState is multi-tenant: row id + composite (businessId,key)
  // unique, while local SyncState uses `key` as the primary key directly.
  SyncState: ['id'],
  // Same pattern: server KdsDayCounter has its own PK because its unique
  // constraint is composite (businessId, dayKey); local uses dayKey as PK.
  KdsDayCounter: ['id'],
};

// Tenancy columns that only exist server-side. They're filtered out of
// the comparison entirely.
const TENANCY_FIELD_NAMES = new Set(['business', 'businessId']);
const TENANCY_TYPE = 'Business';

interface FieldInfo {
  name: string;
  type: string; // normalized: e.g. "String?", "Int", "Decimal"
  raw: string;
}

interface ParsedSchema {
  models: Map<string, Map<string, FieldInfo>>;
  enums: Map<string, Set<string>>;
  modelNames: Set<string>;
}

function parseSchema(filePath: string): ParsedSchema {
  const src = readFileSync(filePath, 'utf8');
  // Strip line comments only; block comments aren't used in these files.
  const cleaned = src.replace(/\/\/[^\n]*/g, '');

  const models = new Map<string, Map<string, FieldInfo>>();
  const enums = new Map<string, Set<string>>();

  const modelRe = /\bmodel\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(cleaned)) !== null) {
    const name = m[1]!;
    const body = m[2]!;
    const fields = new Map<string, FieldInfo>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('@@')) continue;
      // field shape:  name  Type   ...modifiers
      const fm = /^(\w+)\s+([\w?[\]]+)\s*(.*)$/.exec(line);
      if (!fm) continue;
      const fieldName = fm[1]!;
      const type = fm[2]!;
      const rest = fm[3] || '';
      fields.set(fieldName, {
        name: fieldName,
        type,
        raw: `${fieldName} ${type}${rest ? ' ' + rest : ''}`.trim(),
      });
    }
    models.set(name, fields);
  }

  const enumRe = /\benum\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  while ((m = enumRe.exec(cleaned)) !== null) {
    const name = m[1]!;
    const values = new Set(
      m[2]!
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    enums.set(name, values);
  }

  return { models, enums, modelNames: new Set(models.keys()) };
}

function isRelationField(
  field: FieldInfo,
  knownModelNames: Set<string>,
): boolean {
  // Lists are always relations: `items MenuItem[]`.
  if (field.type.endsWith('[]')) return true;
  // Explicit relation annotation.
  if (/@relation\b/.test(field.raw)) return true;
  // Single-side relation without annotation: type is a known model.
  const base = field.type.replace(/[?[\]]/g, '');
  if (knownModelNames.has(base)) return true;
  return false;
}

function isTenancyField(field: FieldInfo): boolean {
  if (TENANCY_FIELD_NAMES.has(field.name)) return true;
  const base = field.type.replace(/[?[\]]/g, '');
  if (base === TENANCY_TYPE) return true;
  return false;
}

function comparableFields(
  modelFields: Map<string, FieldInfo>,
  knownModelNames: Set<string>,
): Map<string, FieldInfo> {
  const out = new Map<string, FieldInfo>();
  for (const [name, info] of modelFields) {
    if (isTenancyField(info)) continue;
    if (isRelationField(info, knownModelNames)) continue;
    out.set(name, info);
  }
  return out;
}

function diffModel(
  modelName: string,
  local: Map<string, FieldInfo>,
  server: Map<string, FieldInfo>,
): string[] {
  const issues: string[] = [];
  const localOnlyAllowed = new Set(ALLOWED_LOCAL_ONLY[modelName] || []);
  const serverOnlyAllowed = new Set(ALLOWED_SERVER_ONLY[modelName] || []);

  for (const [name, info] of local) {
    if (!server.has(name)) {
      if (!localOnlyAllowed.has(name)) {
        issues.push(
          `  + ${modelName}.${name} (${info.type}) exists only in LOCAL schema`,
        );
      }
      continue;
    }
    const serverInfo = server.get(name)!;
    if (info.type !== serverInfo.type) {
      issues.push(
        `  ~ ${modelName}.${name}: local "${info.type}" vs server "${serverInfo.type}"`,
      );
    }
  }
  for (const [name, info] of server) {
    if (!local.has(name)) {
      if (!serverOnlyAllowed.has(name)) {
        issues.push(
          `  - ${modelName}.${name} (${info.type}) exists only in SERVER schema`,
        );
      }
    }
  }
  return issues;
}

function diffEnum(
  enumName: string,
  local: Set<string> | undefined,
  server: Set<string> | undefined,
): string[] {
  if (!local && !server) return [];
  if (!local) return [`  ! enum ${enumName} missing in LOCAL schema`];
  if (!server) return [`  ! enum ${enumName} missing in SERVER schema`];
  const issues: string[] = [];
  const localExtraAllowed = ALLOWED_ENUM_VALUES_LOCAL_ONLY[enumName];
  for (const v of local) {
    if (!server.has(v)) {
      if (localExtraAllowed?.has(v)) continue;
      issues.push(`  + enum ${enumName}.${v} only in LOCAL`);
    }
  }
  for (const v of server) {
    if (!local.has(v)) issues.push(`  - enum ${enumName}.${v} only in SERVER`);
  }
  return issues;
}

function main(): void {
  const local = parseSchema(LOCAL_SCHEMA);
  const server = parseSchema(SERVER_SCHEMA);
  const allModelNames = new Set<string>([
    ...local.modelNames,
    ...server.modelNames,
  ]);

  const allIssues: string[] = [];

  for (const model of SHARED_MODELS) {
    const localFields = local.models.get(model);
    const serverFields = server.models.get(model);
    if (!localFields && !serverFields) {
      allIssues.push(`  ! model ${model} missing in BOTH schemas`);
      continue;
    }
    if (!localFields) {
      allIssues.push(`  ! model ${model} missing in LOCAL schema`);
      continue;
    }
    if (!serverFields) {
      allIssues.push(`  ! model ${model} missing in SERVER schema`);
      continue;
    }
    const lc = comparableFields(localFields, allModelNames);
    const sc = comparableFields(serverFields, allModelNames);
    allIssues.push(...diffModel(model, lc, sc));
  }

  for (const e of SHARED_ENUMS) {
    allIssues.push(...diffEnum(e, local.enums.get(e), server.enums.get(e)));
  }

  if (allIssues.length === 0) {
    console.log('OK: local and server Prisma schemas agree on shared models.');
    process.exit(0);
  }

  console.error('Schema parity check FAILED:\n');
  for (const issue of allIssues) console.error(issue);
  console.error(
    '\nFix by editing prisma/schema.prisma and/or server/prisma/schema.prisma,',
  );
  console.error(
    'then run `pnpm db:migrate` (local) and a server migration as needed.',
  );
  console.error(
    'If a field is intentionally one-sided, add it to ALLOWED_LOCAL_ONLY or',
  );
  console.error('ALLOWED_SERVER_ONLY in scripts/checkSchemaParity.ts.');
  process.exit(1);
}

main();
