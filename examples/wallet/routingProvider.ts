// Excerpt from the private production repository, included for illustration.
// It is not runnable on its own: imports refer to modules that are not published here.

import type { CustomerMessage, LoyaltyCard } from '@loyalty/shared';
import type { PushOutcome, WalletProvider } from './provider.ts';

/**
 * One provider per platform, chosen by the card.
 *
 * `customer.platform` was stored from the first day for exactly this (§6). The
 * domain keeps calling one `WalletProvider`; this is the only place that knows
 * there are two, so adding Google changed no call site on the Apple path.
 */
export class RoutingWalletProvider implements WalletProvider {
  readonly #apple: WalletProvider;
  readonly #google: WalletProvider;

  constructor(providers: { apple: WalletProvider; google: WalletProvider }) {
    this.#apple = providers.apple;
    this.#google = providers.google;
  }

  #for(card: LoyaltyCard): WalletProvider {
    return card.customer.platform === 'google' ? this.#google : this.#apple;
  }

  issue(card: LoyaltyCard): Promise<{ installUrl: string }> {
    return this.#for(card).issue(card);
  }
  pushUpdate(card: LoyaltyCard): Promise<PushOutcome> {
    return this.#for(card).pushUpdate(card);
  }
  revoke(card: LoyaltyCard): Promise<void> {
    return this.#for(card).revoke(card);
  }
  /** Always present here, so the domain need not know which platform lacks it. */
  announce(card: LoyaltyCard, message: CustomerMessage): Promise<PushOutcome> {
    const provider = this.#for(card);
    return provider.announce ? provider.announce(card, message) : provider.pushUpdate(card);
  }
  async settle(): Promise<void> {
    await Promise.all([this.#apple.settle?.(), this.#google.settle?.()]);
  }
}
