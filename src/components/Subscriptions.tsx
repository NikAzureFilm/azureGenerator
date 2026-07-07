import { useNavigate } from '@tanstack/react-router';
import { Check, Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getLevel, useAuth, type BillingStatus } from '@/contexts/AuthContext';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useManageSubscription,
  useSubscriptionService,
  useTokenPackPurchase,
} from '@/services/subscriptionService';
import { useTokenPacks } from '@/hooks/useTokenPacks';
import {
  useSubscriptionProducts,
  type BillingProduct,
  type SubscriptionLevel,
} from '@/hooks/useBillingProducts';
import {
  PLAN_DISPLAY_NAMES,
  PLAN_FEATURES,
  PLAN_ORDER,
  type PlanLevel,
} from '@/config/plan-features';
import {
  FREE_STARTER_TOKENS,
  getAnnualDiscountPercent,
} from '@shared/pricingCatalog';
import {
  CAD_PREMIUM_GENERATION_TOKEN_COST,
  FEATURE_COSTS,
} from '@shared/tokenCosts';
import { formatFull, formatPeriodEnd } from '@/lib/tokenFormat';

type Cadence = 'monthly' | 'yearly';

type SubscriptionTier = {
  level: PlanLevel;
  displayName: string;
  description: string;
  price: string;
  oldPrice?: string;
  priceId: string | null;
  tokenAmount: number | null;
  popular: boolean;
};

function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2);
}

function monthlyEquivalent(product: BillingProduct): number {
  if (product.interval === 'year') return product.priceCents / 12;
  return product.priceCents;
}

function findProduct(
  products: BillingProduct[],
  level: SubscriptionLevel,
  interval: 'month' | 'year',
): BillingProduct | undefined {
  return products.find(
    (p) =>
      p.subscriptionLevel === level &&
      p.interval === interval &&
      p.productType === 'subscription' &&
      p.active,
  );
}

function buildTier(
  products: BillingProduct[],
  level: PlanLevel,
  cadence: Cadence,
): SubscriptionTier | null {
  if (level === 'free') {
    return {
      level: 'free',
      displayName: PLAN_DISPLAY_NAMES.free,
      description: PLAN_FEATURES.free.description,
      price: '0',
      priceId: null,
      tokenAmount: null,
      popular: false,
    };
  }
  const interval: 'month' | 'year' = cadence === 'yearly' ? 'year' : 'month';
  const product = findProduct(products, level, interval);
  if (!product) return null;
  const monthly = findProduct(products, level, 'month');
  const tier: SubscriptionTier = {
    level,
    displayName: PLAN_DISPLAY_NAMES[level],
    description: PLAN_FEATURES[level].description,
    price: formatPrice(monthlyEquivalent(product)),
    priceId: product.stripePriceId,
    tokenAmount: product.tokenAmount,
    popular: level === 'pro',
  };
  if (cadence === 'yearly' && monthly) {
    tier.oldPrice = formatPrice(monthly.priceCents);
  }
  return tier;
}

// Rough "what does this buy" line, derived from FEATURE_COSTS so it tracks
// pricing changes automatically instead of hardcoding counts.
function meshAndCadEquivalents(tokens: number): string {
  const meshes = Math.floor(tokens / FEATURE_COSTS.ultraMesh.tokens);
  const cad = Math.floor(tokens / CAD_PREMIUM_GENERATION_TOKEN_COST);
  return `${meshes} max-quality 3D meshes or ${cad} CAD generations`;
}

function creditsLines(tier: SubscriptionTier): string[] {
  if (tier.level === 'free') {
    const starter = `${FREE_STARTER_TOKENS.toLocaleString()} free starter tokens`;
    const cad = Math.floor(
      FREE_STARTER_TOKENS / CAD_PREMIUM_GENERATION_TOKEN_COST,
    );
    return [starter, `≈ ${cad} CAD generations to try it out`];
  }
  const amount = tier.tokenAmount ?? 0;
  return [
    `${amount.toLocaleString()} tokens per month`,
    `≈ ${meshAndCadEquivalents(amount)} / month`,
    'Tokens reset monthly — no rollover',
  ];
}

function TokenBalanceHeader({
  billing,
  currentLevel,
}: {
  billing: BillingStatus;
  currentLevel: PlanLevel;
}) {
  const { free, subscription, purchased, total } = billing.tokens;
  const isFree = currentLevel === 'free';
  const resetsOn = formatPeriodEnd(billing.subscription?.currentPeriodEnd);

  type StatCard = { key: string; label: string; value: number; note?: string };
  const cards: StatCard[] = [];
  if (!isFree) {
    cards.push({
      key: 'plan',
      label: `${PLAN_DISPLAY_NAMES[currentLevel]} plan tokens`,
      value: subscription,
      note: resetsOn ? `resets ${resetsOn}` : undefined,
    });
  }
  if (free > 0) {
    cards.push({
      key: 'free',
      label: 'Free starter tokens',
      value: free,
    });
  }
  if (purchased > 0) {
    cards.push({
      key: 'purchased',
      label: 'Purchased tokens',
      value: purchased,
      note: 'never expire',
    });
  }

  return (
    <div className="mx-auto mb-10 max-w-3xl px-8">
      <div className="rounded-xl border border-adam-neutral-800 bg-adam-neutral-950 p-6">
        <div className="flex flex-col items-center text-center">
          <span className="text-xs font-medium uppercase tracking-wide text-adam-neutral-400">
            Your tokens
          </span>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-4xl font-light tabular-nums text-white">
              {formatFull(total)}
            </span>
            <span className="text-sm text-adam-neutral-400">tokens</span>
          </div>
        </div>

        {cards.length > 0 && (
          <div
            className={cn(
              'mt-6 grid gap-3',
              cards.length === 1
                ? 'grid-cols-1'
                : cards.length === 2
                  ? 'grid-cols-1 sm:grid-cols-2'
                  : 'grid-cols-1 sm:grid-cols-3',
            )}
          >
            {cards.map((card) => (
              <div
                key={card.key}
                className="rounded-lg border border-adam-neutral-800 bg-adam-neutral-900/40 p-4 text-center"
              >
                <div className="text-2xl font-light tabular-nums text-white">
                  {formatFull(card.value)}
                </div>
                <div className="mt-1 text-xs font-medium text-adam-neutral-200">
                  {card.label}
                </div>
                {card.note && (
                  <div className="mt-0.5 text-xs text-adam-neutral-500">
                    {card.note}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="mt-4 text-center text-xs text-adam-neutral-400">
          Plan tokens reset to your plan&apos;s amount each billing month —
          unused plan tokens don&apos;t roll over. Purchased token packs never
          expire and are spent after plan tokens.
        </p>
      </div>
    </div>
  );
}

export function Subscriptions() {
  const navigate = useNavigate();
  const { user, billing } = useAuth();
  const currentLevel = getLevel(billing);

  const { data: products = [] } = useSubscriptionProducts();

  const { mutate: handleSubscribeMutation, isPending: isSubscribeLoading } =
    useSubscriptionService();
  const { mutate: handleManageSubscription, isPending: isManageLoading } =
    useManageSubscription();
  const { data: tokenPacks = [] } = useTokenPacks();
  const {
    mutate: purchaseTokenPack,
    isPending: isPurchaseLoading,
    variables: purchaseVariables,
  } = useTokenPackPurchase();

  const buildTiers = (cadence: Cadence): SubscriptionTier[] =>
    PLAN_ORDER.map((level) => buildTier(products, level, cadence)).filter(
      (t): t is SubscriptionTier => t !== null,
    );

  const yearlyTiers = buildTiers('yearly');
  const monthlyTiers = buildTiers('monthly');

  const handleSubscribe = (priceId: string) => {
    if (!user) {
      navigate({ to: '/signin' });
      return;
    }
    handleSubscribeMutation({ priceId, source: 'subscriptions' });
  };

  const renderTiers = (tiers: SubscriptionTier[]) => (
    <div className="mx-auto grid max-w-[340px] grid-cols-1 justify-items-center gap-4 px-4 sm:max-w-[640px] sm:grid-cols-2 md:px-8 xl:max-w-none xl:grid-cols-4">
      {tiers.map((tier) => (
        <SubscriptionCard
          key={tier.level}
          tier={tier}
          currentLevel={currentLevel}
          isLoading={isSubscribeLoading || isManageLoading}
          onSubscribe={handleSubscribe}
          onManage={() => handleManageSubscription()}
          totalCards={tiers.length}
        />
      ))}
    </div>
  );

  return (
    <div className="min-h-screen w-full bg-adam-bg-secondary-dark">
      <div className="flex min-h-screen w-full flex-col items-center justify-center py-12">
        <div className="w-full max-w-6xl">
          <div className="mb-8 px-8 text-center">
            <h1 className="mb-2 font-kumbh-sans text-3xl font-light text-white">
              Choose a plan that works for you
            </h1>
            <p className="text-sm text-adam-neutral-300">
              All plans include access to every AI feature. Upgrade for more
              tokens.
            </p>
          </div>

          {user && billing && (
            <TokenBalanceHeader billing={billing} currentLevel={currentLevel} />
          )}

          <Tabs
            defaultValue="monthly"
            className="flex w-full flex-col items-center"
          >
            <TabsList className="mb-8 border border-adam-neutral-700 bg-adam-neutral-900">
              <TabsTrigger
                value="monthly"
                className="data-[state=active]:bg-adam-neutral-100 data-[state=active]:text-adam-neutral-900"
              >
                Monthly
              </TabsTrigger>
              <TabsTrigger
                value="yearly"
                className="gap-1.5 pr-2 data-[state=active]:bg-adam-neutral-100 data-[state=active]:text-adam-neutral-900"
              >
                Annual
                <span className="rounded-full bg-adam-blue px-2.5 py-0.5 text-xs font-semibold text-white">
                  -{getAnnualDiscountPercent('pro')}%
                </span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="yearly" className="w-full">
              {renderTiers(yearlyTiers)}
            </TabsContent>
            <TabsContent value="monthly" className="w-full">
              {renderTiers(monthlyTiers)}
            </TabsContent>
          </Tabs>

          {user && (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={() => handleManageSubscription()}
                disabled={isManageLoading || isSubscribeLoading}
                className="inline-flex items-center gap-1.5 text-xs text-adam-neutral-300 underline-offset-4 hover:text-adam-neutral-100 hover:underline disabled:opacity-60"
              >
                {isManageLoading && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Manage billing
              </button>
            </div>
          )}

          {/* Token Packs */}
          {tokenPacks.length > 0 && (
            <div className="mt-12 px-8">
              <div className="mx-auto max-w-4xl">
                <div className="mb-6 text-center">
                  <h2 className="mb-2 text-xl font-light text-white">
                    Need more tokens?
                  </h2>
                  <p className="text-sm text-adam-neutral-300">
                    Purchase token packs that never expire. Use them anytime.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {tokenPacks.map((pack) => {
                    const isThisPending =
                      isPurchaseLoading &&
                      purchaseVariables?.priceId === pack.stripePriceId;
                    return (
                      <div
                        key={pack.id}
                        className="flex flex-col items-center rounded-xl border border-adam-neutral-800 bg-adam-neutral-950 p-5 text-center"
                      >
                        <div className="text-2xl font-light tabular-nums text-white">
                          {pack.tokenAmount.toLocaleString()}
                        </div>
                        <div className="text-xs text-adam-neutral-400">
                          tokens
                        </div>
                        <div className="mt-2 text-lg font-light text-white">
                          ${formatPrice(pack.priceCents)}
                        </div>
                        <div className="mt-0.5 text-xs text-adam-neutral-500">
                          Never expires
                        </div>
                        <Button
                          variant="dark"
                          className="mt-4 w-full rounded-full border border-adam-neutral-700 font-light"
                          disabled={isPurchaseLoading || !pack.stripePriceId}
                          onClick={() =>
                            pack.stripePriceId &&
                            purchaseTokenPack({ priceId: pack.stripePriceId })
                          }
                        >
                          {isThisPending && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          Buy
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SubscriptionCard({
  tier,
  currentLevel,
  isLoading,
  onSubscribe,
  onManage,
  totalCards,
}: {
  tier: SubscriptionTier;
  currentLevel: PlanLevel;
  isLoading: boolean;
  onSubscribe: (priceId: string) => void;
  onManage: () => void;
  totalCards: number;
}) {
  const isCurrent = tier.level === currentLevel;
  const features = [
    ...creditsLines(tier),
    ...PLAN_FEATURES[tier.level].features,
  ];

  return (
    <Card
      className={cn(
        'relative flex w-full flex-col border bg-adam-neutral-950 transition-all duration-200',
        totalCards === 2 ? 'md:max-w-[340px]' : 'md:max-w-[300px]',
        tier.popular
          ? 'border-adam-blue/50 bg-adam-blue/[0.04] shadow-[0_0_40px_-8px_rgba(15,95,244,0.2)]'
          : 'border-adam-neutral-800',
      )}
    >
      {tier.popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="flex items-center gap-1 rounded-full bg-adam-blue px-3 py-1 text-xs font-medium text-white">
            <Sparkles className="h-3 w-3" />
            Most Popular
          </span>
        </div>
      )}

      <CardHeader className="pb-2 pt-6">
        <div className="mb-1 text-sm font-medium text-adam-neutral-300">
          {tier.displayName}
        </div>
        <div className="flex items-baseline gap-1">
          {tier.oldPrice && (
            <span className="text-sm text-adam-neutral-500 line-through">
              ${tier.oldPrice}
            </span>
          )}
          <span className="text-4xl font-light text-white">${tier.price}</span>
          <span className="text-sm text-adam-neutral-400">/mo</span>
        </div>
        <p className="mt-1 text-xs text-adam-neutral-400">{tier.description}</p>
      </CardHeader>

      <CardContent className="flex-1 pb-4 pt-4">
        <ul className="flex flex-col gap-2.5">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5">
              <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-adam-blue" />
              <span className="text-sm text-adam-neutral-200">{feature}</span>
            </li>
          ))}
        </ul>
      </CardContent>

      <CardFooter className="pb-6 pt-2">
        {isCurrent ? (
          <Button
            className="h-10 w-full rounded-full bg-adam-neutral-800 text-sm font-medium text-adam-neutral-400"
            disabled
          >
            Current Plan
          </Button>
        ) : tier.level === 'free' && currentLevel !== 'free' ? (
          <Button
            className="h-10 w-full rounded-full bg-adam-neutral-800 text-sm font-medium text-adam-neutral-200 hover:bg-adam-neutral-700"
            onClick={onManage}
          >
            Manage Plan
          </Button>
        ) : (
          <Button
            className={cn(
              'h-10 w-full rounded-full text-sm font-medium transition-all',
              tier.popular
                ? 'bg-adam-blue text-white hover:bg-adam-blue/90'
                : 'bg-adam-neutral-100 text-adam-neutral-900 hover:bg-white',
            )}
            onClick={() =>
              currentLevel !== 'free'
                ? onManage()
                : tier.priceId && onSubscribe(tier.priceId)
            }
            disabled={isLoading || (!tier.priceId && currentLevel === 'free')}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading...
              </>
            ) : currentLevel !== 'free' ? (
              'Manage Plan'
            ) : (
              `Get ${tier.displayName}`
            )}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
