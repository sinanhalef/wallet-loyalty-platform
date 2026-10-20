// Excerpt from the private production repository, included for illustration.
// It is not runnable on its own: imports refer to modules that are not published here.

import type { CustomerMessage, LoyaltyCard } from '@loyalty/shared';

/**
 * The seam between domain logic and any wallet platform (LOYALTY_PROJECT.md §6).
 *
 * Nothing in `src/domain/**` may import from `src/apple/**`. Domain code talks
 * to this interface only, so adding Google Wallet later is a new implementation
 * rather than a rewrite.
 */
/**
 * What became of one nudge.
 *
 * Deliberately modest about what it can claim. `delivered` means APNs accepted
 * the notification for at least one device — never that Wallet acted on it,
 * which nothing on this side can observe (HANDOFF §6). So the only honest
 * failures are the two below: nobody has the pass installed, or APNs refused
 * it outright.
 */
export type PushOutcome =
  | { status: 'delivered'; devices: number }
  | { status: 'no-devices' }
  | { status: 'failed'; detail: string };

export interface WalletProvider {
  /** Produces the URL (or data URL) the customer taps to install their card. */
  issue(card: LoyaltyCard): Promise<{ installUrl: string }>;

  /**
   * Nudges the customer's device to re-fetch the card.
   *
   * Best-effort and asynchronous by contract: implementations must resolve even
   * when the push fails, and must never make a stamp look like it failed
   * because the notification did (§2.2). That is why this **returns** an
   * outcome rather than throwing one — the caller records it and carries on.
   */
  pushUpdate(card: LoyaltyCard): Promise<PushOutcome>;

  /** Invalidates a card, e.g. after a lost-phone re-issue. */
  revoke(card: LoyaltyCard): Promise<void>;

  /**
   * Puts a broadcast in front of the customer (HANDOFF §18).
   *
   * Optional, because on Apple it is not a separate operation: the message is
   * already in the pass the card carries, and `pushUpdate` is what makes the
   * phone fetch it and show the banner. Google has no field that notifies, so
   * its provider implements this with the platform's own message call. A
   * provider without it is sent `pushUpdate` instead. Same contract as that:
   * resolves with an outcome, never throws.
   */
  announce?(card: LoyaltyCard, message: CustomerMessage): Promise<PushOutcome>;

  /**
   * Waits for any update still in flight. Optional: only a provider that
   * answers `pushUpdate` before the platform has, and finishes afterwards,
   * has anything to wait for. Called on shutdown so a stamp taken in the last
   * second before Cloud Run stops the instance still reaches the phone.
   */
  settle?(): Promise<void>;
}
