import assert from 'node:assert/strict';
import {
  getFallbackSubscriptionProducts,
  getFallbackTokenPackProducts,
} from './billingProductFallbacks.ts';

const subscriptions = getFallbackSubscriptionProducts();

assert.deepEqual(
  subscriptions.map((product) => [
    product.subscriptionLevel,
    product.interval,
    product.tokenAmount,
    product.priceCents,
    product.stripePriceId,
  ]),
  [
    ['standard', 'month', 1000, 3000, ''],
    ['standard', 'year', 1000, 21600, ''],
    ['pro', 'month', 5000, 15000, ''],
    ['pro', 'year', 5000, 108000, ''],
  ],
);

const packs = getFallbackTokenPackProducts();

assert.deepEqual(
  packs.map((product) => [
    product.name,
    product.tokenAmount,
    product.priceCents,
    product.stripePriceId,
  ]),
  [
    ['500 tokens', 500, 1500, ''],
    ['1,000 tokens', 1000, 3000, ''],
    ['2,500 tokens', 2500, 7500, ''],
    ['5,000 tokens', 5000, 15000, ''],
  ],
);
