export type TokenChargeBody = {
  tokens: number;
  operation?: 'mesh' | 'parametric' | 'chat' | 'refund';
  referenceId?: string;
  userId?: string;
};

export type TokenConsumeResult =
  | {
      ok: true;
      tokensDeducted: number;
      freeBalance: number;
      subscriptionBalance: number;
      purchasedBalance: number;
      totalBalance: number;
    }
  | {
      ok: false;
      reason: 'insufficient_tokens';
      tokensRequired: number;
      tokensAvailable: number;
      tokensDeducted: number;
    };

export type TrackedTokenCharge = {
  email: string;
  body: TokenChargeBody;
};

export type RefundFailure = {
  charge: TrackedTokenCharge;
  error: unknown;
};

type BillingClientLike = {
  consume: (
    email: string,
    body: TokenChargeBody,
  ) => Promise<TokenConsumeResult>;
  refund: (email: string, body: TokenChargeBody) => Promise<unknown>;
};

export class RefundableTokenLedger {
  private charges: TrackedTokenCharge[] = [];

  constructor(private readonly billingClient: BillingClientLike) {}

  async consume(
    email: string,
    body: TokenChargeBody,
  ): Promise<TokenConsumeResult> {
    const result = await this.billingClient.consume(email, body);
    if (result.ok) {
      this.charges.push({ email, body: { ...body } });
    }
    return result;
  }

  settleReference(referenceId: string): void {
    this.charges = this.charges.filter(
      (charge) => charge.body.referenceId !== referenceId,
    );
  }

  async refundReference(
    referenceId: string,
    onRefundError?: (failure: RefundFailure) => void,
  ): Promise<RefundFailure[]> {
    return await this.refundMatching(
      (charge) => charge.body.referenceId === referenceId,
      onRefundError,
    );
  }

  async refundAll(
    onRefundError?: (failure: RefundFailure) => void,
  ): Promise<RefundFailure[]> {
    return await this.refundMatching(() => true, onRefundError);
  }

  private async refundMatching(
    predicate: (charge: TrackedTokenCharge) => boolean,
    onRefundError?: (failure: RefundFailure) => void,
  ): Promise<RefundFailure[]> {
    const selected = this.charges.filter(predicate).reverse();
    this.charges = this.charges.filter((charge) => !predicate(charge));

    const failures: RefundFailure[] = [];
    for (const charge of selected) {
      try {
        await this.billingClient.refund(charge.email, charge.body);
      } catch (error) {
        const failure = { charge, error };
        failures.push(failure);
        onRefundError?.(failure);
      }
    }
    return failures;
  }
}
