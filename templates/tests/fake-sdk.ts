// A stand-in for npm:@base44/sdk in tests/billing.test.ts (mapped by tests/import_map.json):
// an in-memory entity store with the calls the billing functions use, and auth.me() from the
// x-test-user header. It copies three platform behaviours the money code depends on: updateMany is
// an atomic compare-and-set, { field: null } matches a missing field, and an id nested in $and
// matches nothing. Not a model of RLS: the leak checks run on the live app.

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
g.__store ??= {} as Record<string, Row[]>;
export const store: Record<string, Row[]> = g.__store;

let seq = 0;

function matches(row: Row, query: Row, nested = false): boolean {
  return Object.entries(query).every(([k, v]) => {
    if (k === '$or') return (v as Row[]).some((q) => matches(row, q, nested));
    if (k === '$and') return (v as Row[]).every((q) => matches(row, q, true));
    // Like the platform: an id inside $and matches nothing (verified on Base44, 10/2026).
    if (nested && (k === 'id' || k === '_id')) return false;
    // Like the platform: { field: null } matches a missing field and an explicit null.
    if (v === null) return row[k] === undefined || row[k] === null;
    return row[k] === v;
  });
}

function sortRows(rows: Row[], sort?: string): Row[] {
  if (!sort) return rows;
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  return [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (desc ? -1 : 1));
}

function entity(name: string) {
  store[name] ??= [];
  const rows = () => store[name];
  return {
    filter: async (query: Row = {}, sort?: string, limit?: number, skip = 0) => {
      await Promise.resolve();
      const out = sortRows(rows().filter((r) => matches(r, query)), sort).slice(skip);
      return structuredClone(limit ? out.slice(0, limit) : out);
    },
    list: async (sort?: string, limit?: number, skip = 0) => {
      await Promise.resolve();
      const out = sortRows(rows(), sort).slice(skip);
      return structuredClone(limit ? out.slice(0, limit) : out);
    },
    get: async (id: string) => {
      await Promise.resolve();
      const row = rows().find((r) => r.id === id);
      if (!row) throw new Error(`Record with id "${id}" not found`);
      return structuredClone(row);
    },
    create: async (data: Row) => {
      await Promise.resolve();
      seq += 1;
      const row = { ...structuredClone(data), id: `${name}-${seq}`, created_date: new Date(Date.now() + seq).toISOString() };
      rows().push(row);
      return structuredClone(row);
    },
    update: async (id: string, data: Row) => {
      await Promise.resolve();
      const row = rows().find((r) => r.id === id);
      if (!row) throw new Error(`Record with id "${id}" not found`);
      Object.assign(row, structuredClone(data));
      return structuredClone(row);
    },
    // Atomic per call, like the platform's compare-and-set: no await between match and write.
    updateMany: async (query: Row, update: { $set: Row }) => {
      await Promise.resolve();
      let updated = 0;
      for (const row of rows()) {
        if (!matches(row, query)) continue;
        Object.assign(row, structuredClone(update.$set));
        updated += 1;
      }
      return { updated };
    },
  };
}

const entities = new Proxy({}, { get: (_t, name: string) => entity(name) });

// SendEmail records what it would send, for a project that wires customer.ts notify to it;
// `email.fail` makes it throw.
g.__email ??= { sent: [] as Row[], fail: false };
export const email: { sent: Row[]; fail: boolean } = g.__email;
const integrations = {
  Core: {
    SendEmail: async (params: Row) => {
      await Promise.resolve();
      if (email.fail) throw new Error('SendEmail failed');
      email.sent.push(structuredClone(params));
      return {};
    },
  },
};

export function createClientFromRequest(req: Request) {
  const header = req.headers.get('x-test-user');
  return {
    auth: {
      me: async () => {
        await Promise.resolve();
        if (!header) throw new Error('401 Unauthorized');
        // URI-encoded by the test, because a header cannot carry Hebrew.
        return JSON.parse(decodeURIComponent(header));
      },
    },
    entities,
    integrations,
    asServiceRole: { entities, integrations },
  };
}
