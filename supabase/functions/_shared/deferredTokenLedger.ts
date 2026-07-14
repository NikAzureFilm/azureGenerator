import { billing } from './billingClient.ts';
import { getServiceRoleSupabaseClient } from './supabaseClient.ts';
import type {
  TokenChargeBody,
  TokenConsumeResult,
  TrackedTokenCharge,
} from './refundableTokenLedger.ts';

type BillingClientLike = {
  getStatus: (email: string) => Promise<{ tokens: { total: number } }>;
  consume: (
    email: string,
    body: TokenChargeBody,
  ) => Promise<TokenConsumeResult>;
};

export type ReservationFailure = {
  charge: TrackedTokenCharge;
  error: unknown;
};

type ReservationResult =
  | { success: true; status: 'reserved' | 'charged' }
  | {
      success: false;
      reason: 'insufficient_tokens';
      tokensRequired: number;
      tokensAvailable: number;
    };

type ClaimResult =
  | {
      status: 'claimed';
      tokens: number;
      operation: NonNullable<TokenChargeBody['operation']>;
    }
  | {
      status: 'already_charged';
      tokens: number;
      operation: NonNullable<TokenChargeBody['operation']>;
    }
  | { status: 'missing' }
  | { status: 'released' }
  | { status: 'settlement_in_progress' };

export type ReservationReleaseState =
  | 'released'
  | 'already_released'
  | 'charged'
  | 'missing'
  | 'settlement_in_progress';

export type DeferredSettlementResult =
  | (Extract<TokenConsumeResult, { ok: true }> & {
      state: 'charged' | 'already_charged';
    })
  | Extract<TokenConsumeResult, { ok: false }>
  | {
      ok: false;
      reason: 'missing_reservation' | 'settlement_in_progress';
      tokensRequired: 0;
      tokensAvailable: 0;
      tokensDeducted: 0;
    };

export interface GenerationReservationStore {
  reserve(args: {
    userId: string;
    referenceId: string;
    operation: NonNullable<TokenChargeBody['operation']>;
    tokens: number;
    availableTokens: number;
    ttlSeconds: number;
  }): Promise<ReservationResult>;
  claim(userId: string, referenceId: string): Promise<ClaimResult>;
  markCharged(userId: string, referenceId: string): Promise<void>;
  resetAfterSettlementError(userId: string, referenceId: string): Promise<void>;
  release(
    userId: string,
    referenceId: string,
  ): Promise<ReservationReleaseState>;
}

class SupabaseGenerationReservationStore implements GenerationReservationStore {
  private readonly supabase = getServiceRoleSupabaseClient();

  async reserve(args: {
    userId: string;
    referenceId: string;
    operation: NonNullable<TokenChargeBody['operation']>;
    tokens: number;
    availableTokens: number;
    ttlSeconds: number;
  }): Promise<ReservationResult> {
    const { data, error } = await this.supabase.rpc(
      'reserve_generation_tokens',
      {
        p_user_id: args.userId,
        p_reference_id: args.referenceId,
        p_operation: args.operation,
        p_tokens: args.tokens,
        p_available_tokens: args.availableTokens,
        p_ttl_seconds: args.ttlSeconds,
      },
    );
    if (error) throw error;
    return data as unknown as ReservationResult;
  }

  async claim(userId: string, referenceId: string): Promise<ClaimResult> {
    const { data, error } = await this.supabase.rpc(
      'claim_generation_token_reservation',
      {
        p_user_id: userId,
        p_reference_id: referenceId,
      },
    );
    if (error) throw error;
    return data as unknown as ClaimResult;
  }

  async markCharged(userId: string, referenceId: string): Promise<void> {
    const { error } = await this.supabase
      .from('generation_token_reservations')
      .update({
        status: 'charged',
        charged_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('reference_id', referenceId)
      .eq('user_id', userId)
      .eq('status', 'settling');
    if (error) throw error;
  }

  async resetAfterSettlementError(
    userId: string,
    referenceId: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from('generation_token_reservations')
      .update({ status: 'reserved', updated_at: new Date().toISOString() })
      .eq('reference_id', referenceId)
      .eq('user_id', userId)
      .eq('status', 'settling');
    if (error) throw error;
  }

  async release(
    userId: string,
    referenceId: string,
  ): Promise<ReservationReleaseState> {
    const { data, error } = await this.supabase.rpc(
      'release_generation_token_reservation',
      {
        p_user_id: userId,
        p_reference_id: referenceId,
      },
    );
    if (error) throw error;
    return data as ReservationReleaseState;
  }
}

const successfulSettlement = (
  tokens: number,
  state: 'charged' | 'already_charged',
): DeferredSettlementResult => ({
  ok: true,
  state,
  tokensDeducted: state === 'charged' ? tokens : 0,
  freeBalance: 0,
  subscriptionBalance: 0,
  purchasedBalance: 0,
  totalBalance: 0,
});

export async function settleReservedGenerationCharge({
  email,
  userId,
  referenceId,
  billingClient = billing,
  store = new SupabaseGenerationReservationStore(),
}: {
  email: string;
  userId: string;
  referenceId: string;
  billingClient?: BillingClientLike;
  store?: GenerationReservationStore;
}): Promise<DeferredSettlementResult> {
  const claim = await store.claim(userId, referenceId);
  if (claim.status === 'already_charged') {
    return successfulSettlement(claim.tokens, 'already_charged');
  }
  if (claim.status === 'missing' || claim.status === 'released') {
    return {
      ok: false,
      reason: 'missing_reservation',
      tokensRequired: 0,
      tokensAvailable: 0,
      tokensDeducted: 0,
    };
  }
  if (claim.status === 'settlement_in_progress') {
    return {
      ok: false,
      reason: 'settlement_in_progress',
      tokensRequired: 0,
      tokensAvailable: 0,
      tokensDeducted: 0,
    };
  }

  try {
    const result = await billingClient.consume(email, {
      tokens: claim.tokens,
      operation: claim.operation,
      referenceId,
      userId,
    });
    if (!result.ok) {
      await store.release(userId, referenceId);
      return result;
    }

    // The billing reference is idempotent. If this bookkeeping write is ever
    // retried, the same reference cannot charge the user twice.
    await store.markCharged(userId, referenceId);
    return { ...result, state: 'charged' };
  } catch (error) {
    await store
      .resetAfterSettlementError(userId, referenceId)
      .catch((resetError) =>
        console.error('Failed to reset generation token reservation:', {
          referenceId,
          resetError,
        }),
      );
    throw error;
  }
}

export async function releaseReservedGenerationCharge({
  userId,
  referenceId,
  store = new SupabaseGenerationReservationStore(),
}: {
  userId: string;
  referenceId: string;
  store?: GenerationReservationStore;
}): Promise<ReservationReleaseState> {
  return await store.release(userId, referenceId);
}

export class DeferredTokenLedger {
  private readonly charges = new Map<string, TrackedTokenCharge>();

  constructor(
    private readonly billingClient: BillingClientLike = billing,
    private readonly store: GenerationReservationStore = new SupabaseGenerationReservationStore(),
  ) {}

  async reserve(
    email: string,
    body: TokenChargeBody,
    { ttlSeconds = 21600 }: { ttlSeconds?: number } = {},
  ): Promise<TokenConsumeResult> {
    if (!body.userId || !body.referenceId || !body.operation) {
      throw new Error(
        'Deferred generation charges require userId, referenceId, and operation',
      );
    }

    const status = await this.billingClient.getStatus(email);
    const result = await this.store.reserve({
      userId: body.userId,
      referenceId: body.referenceId,
      operation: body.operation,
      tokens: body.tokens,
      availableTokens: status.tokens.total,
      ttlSeconds,
    });
    if (!result.success) {
      return {
        ok: false,
        reason: 'insufficient_tokens',
        tokensRequired: result.tokensRequired,
        tokensAvailable: result.tokensAvailable,
        tokensDeducted: 0,
      };
    }

    this.charges.set(body.referenceId, { email, body: { ...body } });
    return {
      ok: true,
      tokensDeducted: 0,
      freeBalance: 0,
      subscriptionBalance: 0,
      purchasedBalance: 0,
      totalBalance: status.tokens.total,
    };
  }

  async commitReference(
    referenceId: string,
  ): Promise<DeferredSettlementResult> {
    const charge = this.charges.get(referenceId);
    if (!charge?.body.userId) {
      return {
        ok: false,
        reason: 'missing_reservation',
        tokensRequired: 0,
        tokensAvailable: 0,
        tokensDeducted: 0,
      };
    }

    const result = await settleReservedGenerationCharge({
      email: charge.email,
      userId: charge.body.userId,
      referenceId,
      billingClient: this.billingClient,
      store: this.store,
    });
    if (result.ok || result.reason !== 'settlement_in_progress') {
      this.charges.delete(referenceId);
    }
    return result;
  }

  async releaseReference(
    referenceId: string,
    onReleaseError?: (failure: ReservationFailure) => void,
  ): Promise<boolean> {
    const charge = this.charges.get(referenceId);
    this.charges.delete(referenceId);
    if (!charge?.body.userId) return false;
    try {
      const state = await this.store.release(charge.body.userId, referenceId);
      return state === 'released' || state === 'already_released';
    } catch (error) {
      onReleaseError?.({ charge, error });
      return false;
    }
  }

  async releaseAll(
    onReleaseError?: (failure: ReservationFailure) => void,
  ): Promise<ReservationFailure[]> {
    const charges = [...this.charges.values()].reverse();
    this.charges.clear();
    const failures: ReservationFailure[] = [];
    for (const charge of charges) {
      if (!charge.body.userId || !charge.body.referenceId) continue;
      try {
        await this.store.release(charge.body.userId, charge.body.referenceId);
      } catch (error) {
        const failure = { charge, error };
        failures.push(failure);
        onReleaseError?.(failure);
      }
    }
    return failures;
  }
}
