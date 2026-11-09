// Shared server helpers: the Israel day, the 422 error contract and the signed-in user.
// No imports here, so every function folder can carry its own copy (see scripts/sync-shared.mjs).
// A project that already has its own common.ts keeps it and adds what is missing from this one.

// ---------- Israel "today" (YYYY-MM-DD) ----------

export function israelToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Calendar months, clamped to the last day of the target month (31/01 + 1 = 28/02 or 29/02).
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// ---------- Responses ----------

export type Reason = { code: string; message: string; field?: string };

export function fail(reasons: Reason[], error = 'הפעולה נכשלה'): Response {
  return Response.json({ error, reasons }, { status: 422 });
}

export function unauthorized(): Response {
  return Response.json(
    { error: 'נדרשת התחברות', reasons: [{ code: 'unauthorized', message: 'נדרשת התחברות' }] },
    { status: 401 },
  );
}

export function forbidden(): Response {
  return Response.json(
    { error: 'אין הרשאה לבצע פעולה זו', reasons: [{ code: 'forbidden', message: 'אין הרשאה לבצע פעולה זו' }] },
    { status: 403 },
  );
}

export function serverError(error: unknown): Response {
  console.error(error);
  return Response.json(
    { error: 'תקלת שרת', reasons: [{ code: 'server_error', message: 'תקלת שרת, נסו שוב' }] },
    { status: 500 },
  );
}

// auth.me() throws on a missing or invalid token instead of returning null.
// deno-lint-ignore no-explicit-any
export async function currentUser(base44: any): Promise<any | null> {
  try {
    return (await base44.auth.me()) ?? null;
  } catch (_) {
    return null;
  }
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch (_) {
    return {};
  }
}
