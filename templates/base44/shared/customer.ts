// The one file to adapt per project: who pays, and how the billing functions find them. Nothing
// else in the templates names the project's own entities.
//
// Default: the signed-in User pays for themselves (customer_id = User.id). When a record pays (a
// Clinic, a Business, a listing), replace the bodies below. One live project read its own profile
// entity by owner_user_id, took the email from the owner's User, and dropped a title (such as "ד"ר")
// from the name before sending it to HYP.
// No imports, so every function folder can carry its own copy (see scripts/sync-shared.mjs).

export type Customer = {
  // What BillingAccount.customer_id and Payment.customer_id hold.
  id: string;
  // The User who may read this customer's payments (Payment RLS reads owner_user_id).
  owner_user_id: string;
  // Sent to HYP as ClientName / ClientLName; HYP prints them on the invoice.
  first_name: string;
  last_name: string;
  email: string;
  // True when this customer may not save a card or be charged (a rejected or deleted account).
  blocked: boolean;
};

// The customer the signed-in user pays for, or null.
// deno-lint-ignore no-explicit-any
export async function findOwnCustomer(_base44: any, user: any): Promise<Customer | null> {
  await Promise.resolve();
  return user?.id ? fromUser(user) : null;
}

// The admin's side: the customer by id, or null.
// deno-lint-ignore no-explicit-any
export async function getCustomer(base44: any, id: string): Promise<Customer | null> {
  if (!id) return null;
  try {
    const user = await base44.asServiceRole.entities.User.get(id);
    return user ? fromUser(user) : null;
  } catch (_) {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
function fromUser(user: any): Customer {
  const full = String(user.full_name || '').trim().replace(/\s+/g, ' ');
  const [first = '', ...rest] = full.split(' ');
  return {
    id: String(user.id),
    owner_user_id: String(user.id),
    first_name: first.slice(0, 50),
    last_name: rest.join(' ').slice(0, 50),
    email: String(user.email || ''),
    blocked: false,
  };
}

// ---------- Subscription hooks (subscription.ts calls them) ----------

// Tells the customer about their subscription. `kind`: trial_ending_no_card, card_expiring,
// charge_failed, expired, cancelled. Default: a log line only. Wire it to the project's channel
// (Base44 SendEmail reaches only the app's registered users; WhatsApp goes through an in-app agent),
// and copy the admin on charge_failed and expired. One language per message, subject and body (and
// the admin's copy too): the customer's chosen language, Hebrew by default; never both languages in
// one email.
// deno-lint-ignore no-explicit-any
export async function notify(_base44: any, customer: Customer | null, kind: string, data: Record<string, unknown>): Promise<void> {
  await Promise.resolve();
  console.log('notify', kind, customer?.id || 'unknown customer', JSON.stringify(data));
}

// Called when a customer's subscription status changes (trial, active, past_due, expired,
// cancelled), for example to hide an expired customer from the public site (out of the public
// listing, never deleted) and show them again once they pay. Default: nothing.
// deno-lint-ignore no-explicit-any
export async function onSubscriptionChange(_base44: any, customerId: string, status: string): Promise<void> {
  await Promise.resolve();
  console.log('onSubscriptionChange', customerId, status);
}
