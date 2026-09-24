import { parsePaymentLinks } from "./stripe.js";

/**
 * BELLMAN_BILLING, the switch for everything Stripe can do:
 *
 * - off     Nothing. The webhook refuses, /upgrade serves no links, and plans
 *           come only from BELLMAN_USERS. The default, and what any value
 *           other than the three below means.
 * - shadow  The webhook records payments and /upgrade sends people to pay,
 *           but tokens ignore what was recorded. For taking real test
 *           purchases end to end, and checking the ledger, before anyone's
 *           plan depends on it.
 * - on      Paid plans reach tokens, at sign-in and on every refresh.
 *
 * It is a var in wrangler.toml rather than a secret so that turning billing
 * on is a reviewed commit, not a dashboard click. The Stripe secrets are
 * still required: setting them alone no longer switches anything on.
 */
export type BillingMode = "off" | "shadow" | "on";

export function billingMode(raw: string | undefined): BillingMode {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "off") return "off";
  if (value === "shadow" || value === "on") return value;
  // Fail closed, loudly: a typo must not switch billing on.
  console.error(`BELLMAN_BILLING is "${raw}", which is not off, shadow or on — treating it as off`);
  return "off";
}

export interface BillingEnv {
  BELLMAN_BILLING?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PAYMENT_LINKS?: string;
}

export interface BillingSettings {
  mode: BillingMode;
  /** The webhook's signing secret, when the webhook should accept events. */
  webhookSecret?: string;
  /** Whether tokens carry the paid plan. */
  applyPlans: boolean;
  paymentLinks: Record<string, string>;
}

export function billingSettings(env: BillingEnv): BillingSettings {
  const mode = billingMode(env.BELLMAN_BILLING);
  if (mode === "off") return { mode, applyPlans: false, paymentLinks: {} };

  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || undefined;
  if (!webhookSecret) {
    // Without the secret no event can be verified, so no payment or
    // cancellation would ever land. Half-on is worse than off: stay off.
    console.error(`BELLMAN_BILLING is ${mode} but STRIPE_WEBHOOK_SECRET is unset — billing stays off`);
    return { mode: "off", applyPlans: false, paymentLinks: {} };
  }
  return {
    mode,
    webhookSecret,
    applyPlans: mode === "on",
    paymentLinks: parsePaymentLinks(env.STRIPE_PAYMENT_LINKS),
  };
}
