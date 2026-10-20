// Excerpt from the private production repository, included for illustration.
// It is not runnable on its own: imports refer to modules that are not published here.

import type { Customer, Shop, Transaction, TransactionType } from '@loyalty/shared';
import { insufficientStamps, invalidAward, stampCooldown } from './errors.ts';

/**
 * The rules of the loyalty scheme, as pure functions.
 *
 * Nothing here touches Firestore, the network, or the clock — `now` is always
 * passed in. That is what makes the awkward cases (cooldown boundaries,
 * redeeming with a surplus, replaying a key) cheap to test exhaustively, which
 * §11 requires. `operations.ts` wraps these in a transaction; the decisions
 * themselves live here.
 *
 * "Award" is the neutral word for what a scan gives: one stamp in a stamp
 * program, an arbitrary number of points in a points one.
 */

export interface CustomerBalanceChange {
  stamps: number;
  lifetimeStamps: number;
  redemptionCount: number;
  lastStampAt: string | null;
}

/** The biggest single award the server will accept, points included. */
export const MAX_AWARD = 1000;

/**
 * Decides how much one scan is worth.
 *
 * A stamp program awards exactly one and refuses to be talked out of it: the
 * amount arrives from a till, and a client that could name its own number would
 * be the one place in the system where a balance comes from outside (§2.1).
 * A points program takes the till's figure, because in a points program that
 * figure is the transaction — it is what the customer just spent.
 */
export function resolveAward(shop: Shop, requested: number | undefined): number {
  if (shop.program.kind === 'stamps') {
    if (requested !== undefined && requested !== 1) {
      throw invalidAward('This shop gives one stamp per visit.');
    }
    return 1;
  }

  const amount = requested ?? shop.program.defaultAward;
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AWARD) {
    throw invalidAward(`Points must be a whole number between 1 and ${MAX_AWARD}.`);
  }
  return amount;
}

/**
 * Rejects a second award inside the shop's cooldown window (§7).
 *
 * This is anti-abuse, not correctness: the QR is a static serial, so a
 * screenshot is transferable, and the cooldown stops one card being stamped
 * repeatedly in a queue. It must be checked *after* idempotency — a barista
 * retrying on bad wifi is replaying one stamp, not asking for a second.
 */
export function assertStampAllowed(shop: Shop, customer: Customer, now: Date): void {
  if (!customer.lastStampAt || shop.program.cooldownSeconds <= 0) return;

  const elapsedMs = now.getTime() - new Date(customer.lastStampAt).getTime();
  const cooldownMs = shop.program.cooldownSeconds * 1000;

  // A clock skew or an edited lastStampAt in the future should not lock a card
  // out forever; treat anything non-positive as "no wait".
  if (elapsedMs >= cooldownMs) return;

  throw stampCooldown(Math.max(1, Math.ceil((cooldownMs - elapsedMs) / 1000)));
}

/** Redemption is only possible at or above the goal (§1). */
export function assertRedeemAllowed(shop: Shop, customer: Customer): void {
  if (customer.stamps < shop.program.goal) {
    throw insufficientStamps(customer.stamps, shop.program.goal);
  }
}

export function isRedeemable(shop: Shop, customer: Customer): boolean {
  return customer.stamps >= shop.program.goal;
}

export function applyStamp(customer: Customer, now: Date, amount = 1): CustomerBalanceChange {
  return {
    stamps: customer.stamps + amount,
    lifetimeStamps: customer.lifetimeStamps + amount,
    redemptionCount: customer.redemptionCount,
    lastStampAt: now.toISOString(),
  };
}

/**
 * Redemption subtracts exactly the goal — it does not zero the balance (§1).
 *
 * A customer with 8 stamps and a goal of 6 keeps 2 afterwards. Zeroing would
 * quietly confiscate them, and it is the kind of bug nobody reports because
 * they assume that is how it works.
 */
export function applyRedeem(shop: Shop, customer: Customer): CustomerBalanceChange {
  return {
    stamps: customer.stamps - shop.program.goal,
    lifetimeStamps: customer.lifetimeStamps,
    redemptionCount: customer.redemptionCount + 1,
    lastStampAt: customer.lastStampAt,
  };
}

/** Manual correction from the dashboard, e.g. fixing a mis-scan. */
export function applyAdjustment(customer: Customer, delta: number): CustomerBalanceChange {
  return {
    // Counts are integers and a balance is never negative (§11).
    stamps: Math.max(0, customer.stamps + delta),
    lifetimeStamps: delta > 0 ? customer.lifetimeStamps + delta : customer.lifetimeStamps,
    redemptionCount: customer.redemptionCount,
    lastStampAt: customer.lastStampAt,
  };
}

export function deltaFor(type: TransactionType, shop: Shop, adjustment = 0): number {
  switch (type) {
    case 'stamp':
      return shop.program.kind === 'points' ? shop.program.defaultAward : 1;
    case 'redeem':
      return -shop.program.goal;
    case 'adjust':
    case 'bonus':
      return adjustment;
  }
}

/**
 * Rebuilds the balance from the append-only log.
 *
 * The `stamps` field on the customer document is a cache kept for read speed.
 * When the two disagree, the log is authoritative (§4) — this is how we find
 * out, and how the dashboard's consistency check will report it.
 */
export function balanceFromLog(transactions: Pick<Transaction, 'delta'>[]): number {
  return transactions.reduce((sum, t) => sum + t.delta, 0);
}
