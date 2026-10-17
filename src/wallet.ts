import Stripe from "stripe";
import { BUDGET_CENTS, type Wallet } from "./types.js";

// The agent's wallet: a $5 authorization hold on a test card. Each hint payment is a ledger line on
// the hold; at the end we capture only what was spent and Stripe releases the rest.
// Indian accounts require 3DS on every on-session confirm, so everything here is off_session on a
// Customer with an attached card.

const ADDRESS = { line1: "402 Payment Required St", city: "San Francisco", state: "CA", postal_code: "94111", country: "US" };

export function createWallet(): Wallet {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return mockWallet();
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) throw new Error("Room 402 only runs on a Stripe TEST key");
  const stripe = new Stripe(key);

  let piId: string | null = null;
  let lines = 0;

  return {
    async open(runId, model) {
      const customer = await stripe.customers.create({
        name: "Room 402 Agent Wallet",
        description: `Wallet for ${model} (run ${runId})`,
        address: ADDRESS,
        metadata: { run: runId, model },
      });
      const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
      const pi = await stripe.paymentIntents.create({
        amount: BUDGET_CENTS,
        currency: "usd",
        customer: customer.id,
        payment_method: pm.id,
        capture_method: "manual",
        off_session: true,
        confirm: true,
        description: `Room 402 budget hold: ${model}`,
        metadata: { run: runId, model },
      });
      piId = pi.id;
      return { paymentIntentId: pi.id };
    },

    async record(line) {
      if (!piId || lines >= 40) return;
      lines++;
      await stripe.paymentIntents.update(piId, { metadata: { [`l${lines}`]: line.slice(0, 500) } });
    },

    async settle(spentCents) {
      if (!piId) return { capturedCents: 0 };
      if (spentCents <= 0) {
        await stripe.paymentIntents.cancel(piId);
        return { capturedCents: 0 };
      }
      const captured = await stripe.paymentIntents.capture(piId, { amount_to_capture: Math.min(spentCents, BUDGET_CENTS) });
      const charge = await stripe.charges.retrieve(captured.latest_charge as string);
      return { capturedCents: captured.amount_received, receiptUrl: charge.receipt_url ?? undefined };
    },
  };
}

function mockWallet(): Wallet {
  console.warn("[wallet] STRIPE_SECRET_KEY missing: using a mock wallet");
  return {
    async open(runId) {
      return { paymentIntentId: `pi_mock_${runId}` };
    },
    async record(line) {
      console.log("[wallet]", line);
    },
    async settle(spentCents) {
      return { capturedCents: spentCents };
    },
  };
}
