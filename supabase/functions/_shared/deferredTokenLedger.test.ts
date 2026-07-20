import {
  DeferredTokenLedger,
  type GenerationReservationStore,
} from './deferredTokenLedger.ts';
import type {
  TokenChargeBody,
  TokenConsumeResult,
} from './refundableTokenLedger.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createStore() {
  const rows = new Map<
    string,
    {
      userId: string;
      tokens: number;
      operation: NonNullable<TokenChargeBody['operation']>;
      status: 'reserved' | 'settling' | 'charged' | 'released';
    }
  >();
  const store: GenerationReservationStore = {
    reserve: (args) => {
      rows.set(args.referenceId, {
        userId: args.userId,
        tokens: args.tokens,
        operation: args.operation,
        status: 'reserved',
      });
      return Promise.resolve({ success: true, status: 'reserved' });
    },
    claim: (userId, referenceId) => {
      const row = rows.get(referenceId);
      if (!row || row.userId !== userId) {
        return Promise.resolve({ status: 'missing' });
      }
      if (row.status === 'charged') {
        return Promise.resolve({
          status: 'already_charged',
          tokens: row.tokens,
          operation: row.operation,
        });
      }
      if (row.status === 'released') {
        return Promise.resolve({ status: 'released' });
      }
      row.status = 'settling';
      return Promise.resolve({
        status: 'claimed',
        tokens: row.tokens,
        operation: row.operation,
      });
    },
    markCharged: (_userId, referenceId) => {
      rows.get(referenceId)!.status = 'charged';
      return Promise.resolve();
    },
    resetAfterSettlementError: (_userId, referenceId) => {
      rows.get(referenceId)!.status = 'reserved';
      return Promise.resolve();
    },
    release: (_userId, referenceId) => {
      const row = rows.get(referenceId);
      if (!row) return Promise.resolve('missing');
      if (row.status === 'charged') return Promise.resolve('charged');
      if (row.status === 'released') {
        return Promise.resolve('already_released');
      }
      row.status = 'released';
      return Promise.resolve('released');
    },
  };
  return { rows, store };
}

Deno.test(
  'failed deferred generations release without consuming tokens',
  async () => {
    const { rows, store } = createStore();
    let consumeCalls = 0;
    const billingClient = {
      getStatus: () => Promise.resolve({ tokens: { total: 100 } }),
      consume: (
        _email: string,
        body: TokenChargeBody,
      ): Promise<TokenConsumeResult> => {
        consumeCalls += 1;
        return Promise.resolve({
          ok: true,
          tokensDeducted: body.tokens,
          freeBalance: 0,
          subscriptionBalance: 100 - body.tokens,
          purchasedBalance: 0,
          totalBalance: 100 - body.tokens,
        });
      },
    };
    const ledger = new DeferredTokenLedger(billingClient, store);

    const reserved = await ledger.reserve('user@example.com', {
      tokens: 25,
      operation: 'parametric',
      referenceId: 'generation-1',
      userId: 'user-1',
    });
    assert(reserved.ok, 'reservation should succeed');

    await ledger.releaseAll();
    assert(consumeCalls === 0, 'failed generation must not consume tokens');
    assert(
      rows.get('generation-1')?.status === 'released',
      'failed generation reservation should be released',
    );
  },
);

Deno.test('successful deferred generations consume exactly once', async () => {
  const { store } = createStore();
  let consumeCalls = 0;
  const billingClient = {
    getStatus: () => Promise.resolve({ tokens: { total: 100 } }),
    consume: (
      _email: string,
      body: TokenChargeBody,
    ): Promise<TokenConsumeResult> => {
      consumeCalls += 1;
      return Promise.resolve({
        ok: true,
        tokensDeducted: body.tokens,
        freeBalance: 0,
        subscriptionBalance: 100 - body.tokens,
        purchasedBalance: 0,
        totalBalance: 100 - body.tokens,
      });
    },
  };
  const ledger = new DeferredTokenLedger(billingClient, store);

  await ledger.reserve('user@example.com', {
    tokens: 34,
    operation: 'mesh',
    referenceId: 'generation-2',
    userId: 'user-1',
  });
  const settled = await ledger.commitReference('generation-2');
  assert(settled.ok, 'completed generation should settle');
  assert(consumeCalls === 1, 'completed generation should consume once');

  const duplicate = await ledger.commitReference('generation-2');
  assert(!duplicate.ok, 'the in-memory ledger must forget settled charges');
  assert(consumeCalls === 1, 'duplicate commit must not consume again');
});
