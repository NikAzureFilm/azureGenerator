import {
  RefundableTokenLedger,
  type TokenChargeBody,
  type TokenConsumeResult,
} from './refundableTokenLedger.ts';

type TestBillingClient = {
  consume: (
    email: string,
    body: TokenChargeBody,
  ) => Promise<TokenConsumeResult>;
  refund: (email: string, body: TokenChargeBody) => Promise<unknown>;
};

Deno.test(
  'refundAll refunds successful consumes once with original charge bodies',
  async () => {
    const refunds: Array<{ email: string; body: TokenChargeBody }> = [];
    const billingClient: TestBillingClient = {
      consume: (_email, body) =>
        Promise.resolve({
          ok: true,
          tokensDeducted: body.tokens,
          freeBalance: 0,
          subscriptionBalance: 90,
          purchasedBalance: 0,
          totalBalance: 90,
        }),
      refund: (email, body) => {
        refunds.push({ email, body });
        return Promise.resolve({
          ok: true,
          tokensRefunded: body.tokens,
          source: 'subscription',
          freeBalance: 0,
          subscriptionBalance: 100,
          purchasedBalance: 0,
          totalBalance: 100,
        });
      },
    };
    const ledger = new RefundableTokenLedger(billingClient);

    await ledger.consume('User@Example.com', {
      tokens: 10,
      operation: 'chat',
      referenceId: 'chat-1',
      userId: 'user-1',
    });

    await ledger.refundAll();
    await ledger.refundAll();

    if (refunds.length !== 1) {
      throw new Error(`expected one refund, got ${refunds.length}`);
    }
    if (refunds[0].email !== 'User@Example.com') {
      throw new Error(`unexpected refund email ${refunds[0].email}`);
    }
    if (refunds[0].body.referenceId !== 'chat-1') {
      throw new Error(`unexpected reference ${refunds[0].body.referenceId}`);
    }
  },
);

Deno.test(
  'consume does not track insufficient-token attempts for refund',
  async () => {
    const refunds: Array<{ email: string; body: TokenChargeBody }> = [];
    const billingClient: TestBillingClient = {
      consume: (_email, body) =>
        Promise.resolve({
          ok: false,
          reason: 'insufficient_tokens',
          tokensRequired: body.tokens,
          tokensAvailable: 0,
          tokensDeducted: 0,
        }),
      refund: (email, body) => {
        refunds.push({ email, body });
        return Promise.resolve({
          ok: true,
          tokensRefunded: body.tokens,
          source: 'subscription',
          freeBalance: 0,
          subscriptionBalance: 0,
          purchasedBalance: 0,
          totalBalance: 0,
        });
      },
    };
    const ledger = new RefundableTokenLedger(billingClient);

    await ledger.consume('user@example.com', {
      tokens: 10,
      operation: 'chat',
      referenceId: 'chat-2',
      userId: 'user-1',
    });
    await ledger.refundAll();

    if (refunds.length !== 0) {
      throw new Error(`expected no refunds, got ${refunds.length}`);
    }
  },
);
