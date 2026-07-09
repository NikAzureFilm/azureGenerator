// Unit coverage for the pure request-validation extracted from the admin API
// routes (admin/lib/apiValidation.ts). These lock in the exact semantics the
// route handlers used to carry inline: same limits, same error strings, same
// trimming/coercion rules — so a future refactor can't silently drift them.
//
// Run from the repo root (same invocation as the other admin/lib/*.test.mjs):
//   node --test admin/lib/apiValidation.test.mjs
// On Node < 22.6 add the flag: node --experimental-strip-types --test <path>

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseTokenAdjustBody,
  parseBudgetBody,
  parseKeySetBody,
  parseKeyDeleteBody,
  isMissingFunctionError,
} from './apiValidation.ts';

const TOKEN_AMOUNT_ERR =
  'amount must be a non-zero integer with |amount| <= 100000';
const TOKEN_SOURCE_ERR = "source must be 'subscription' or 'purchased'";
const TOKEN_NOTE_ERR = 'note is required and must be <= 200 chars';
const BUDGET_RANGE_ERR =
  'monthlyBudgetUsd must be null or a number between 0 and 1000000';
const PROVIDER_ERR = 'provider is required';
const INVALID_BODY_ERR = 'Invalid request body';
const KEY_MISSING_ERR = 'apiKey is required';
const KEY_LEN_ERR = 'apiKey must be between 8 and 512 characters';
const KEY_CHAR_ERR = 'apiKey must not contain whitespace or control characters';

// ===========================================================================
// parseTokenAdjustBody
// ===========================================================================

test('token: valid credit body', () => {
  const r = parseTokenAdjustBody({
    amount: 500,
    source: 'purchased',
    note: 'promo credit',
  });
  assert.deepEqual(r, {
    ok: true,
    value: { amount: 500, source: 'purchased', note: 'promo credit' },
  });
});

test('token: valid debit body', () => {
  const r = parseTokenAdjustBody({
    amount: -250,
    source: 'subscription',
    note: 'chargeback clawback',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    amount: -250,
    source: 'subscription',
    note: 'chargeback clawback',
  });
});

test('token: amount = 0 is rejected', () => {
  const r = parseTokenAdjustBody({ amount: 0, source: 'purchased', note: 'x' });
  assert.deepEqual(r, { ok: false, error: TOKEN_AMOUNT_ERR });
});

test('token: non-integer amount is rejected', () => {
  const r = parseTokenAdjustBody({
    amount: 12.5,
    source: 'purchased',
    note: 'x',
  });
  assert.deepEqual(r, { ok: false, error: TOKEN_AMOUNT_ERR });
});

test('token: amount 100001 (over positive cap) is rejected', () => {
  const r = parseTokenAdjustBody({
    amount: 100001,
    source: 'purchased',
    note: 'x',
  });
  assert.deepEqual(r, { ok: false, error: TOKEN_AMOUNT_ERR });
});

test('token: amount -100001 (over negative cap) is rejected', () => {
  const r = parseTokenAdjustBody({
    amount: -100001,
    source: 'purchased',
    note: 'x',
  });
  assert.deepEqual(r, { ok: false, error: TOKEN_AMOUNT_ERR });
});

test('token: boundary amount +100000 is accepted', () => {
  const r = parseTokenAdjustBody({
    amount: 100000,
    source: 'purchased',
    note: 'x',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.amount, 100000);
});

test('token: boundary amount -100000 is accepted', () => {
  const r = parseTokenAdjustBody({
    amount: -100000,
    source: 'purchased',
    note: 'x',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.amount, -100000);
});

test('token: non-number amount (string) is rejected', () => {
  const r = parseTokenAdjustBody({
    amount: '500',
    source: 'purchased',
    note: 'x',
  });
  assert.deepEqual(r, { ok: false, error: TOKEN_AMOUNT_ERR });
});

test('token: NaN amount is rejected', () => {
  const r = parseTokenAdjustBody({
    amount: NaN,
    source: 'purchased',
    note: 'x',
  });
  assert.deepEqual(r, { ok: false, error: TOKEN_AMOUNT_ERR });
});

test('token: bad source value is rejected', () => {
  const r = parseTokenAdjustBody({
    amount: 5,
    source: 'refund',
    note: 'x',
  });
  assert.deepEqual(r, { ok: false, error: TOKEN_SOURCE_ERR });
});

test('token: non-string source is rejected', () => {
  const r = parseTokenAdjustBody({ amount: 5, source: 42, note: 'x' });
  assert.deepEqual(r, { ok: false, error: TOKEN_SOURCE_ERR });
});

test('token: missing source is rejected', () => {
  const r = parseTokenAdjustBody({ amount: 5, note: 'x' });
  assert.deepEqual(r, { ok: false, error: TOKEN_SOURCE_ERR });
});

test('token: missing note is rejected', () => {
  const r = parseTokenAdjustBody({ amount: 5, source: 'purchased' });
  assert.deepEqual(r, { ok: false, error: TOKEN_NOTE_ERR });
});

test('token: blank (whitespace-only) note is rejected', () => {
  const r = parseTokenAdjustBody({
    amount: 5,
    source: 'purchased',
    note: '   ',
  });
  assert.deepEqual(r, { ok: false, error: TOKEN_NOTE_ERR });
});

test('token: empty-string note is rejected', () => {
  const r = parseTokenAdjustBody({ amount: 5, source: 'purchased', note: '' });
  assert.deepEqual(r, { ok: false, error: TOKEN_NOTE_ERR });
});

test('token: 201-char note is rejected (route caps raw length, does not truncate)', () => {
  const r = parseTokenAdjustBody({
    amount: 5,
    source: 'purchased',
    note: 'a'.repeat(201),
  });
  assert.deepEqual(r, { ok: false, error: TOKEN_NOTE_ERR });
});

test('token: boundary 200-char note is accepted (raw length == 200)', () => {
  const note = 'a'.repeat(200);
  const r = parseTokenAdjustBody({ amount: 5, source: 'purchased', note });
  assert.equal(r.ok, true);
  assert.equal(r.value.note, note);
});

test('token: note is NOT trimmed on the accepted value', () => {
  // The route passes the raw note through (only .trim() gates emptiness); the
  // stored value keeps surrounding whitespace.
  const r = parseTokenAdjustBody({
    amount: 5,
    source: 'purchased',
    note: '  padded  ',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.note, '  padded  ');
});

test('token: non-string note is rejected', () => {
  const r = parseTokenAdjustBody({ amount: 5, source: 'purchased', note: 12 });
  assert.deepEqual(r, { ok: false, error: TOKEN_NOTE_ERR });
});

test('token: null body -> Invalid request body (route threw on property access)', () => {
  const r = parseTokenAdjustBody(null);
  assert.deepEqual(r, { ok: false, error: INVALID_BODY_ERR });
});

test('token: undefined body -> Invalid request body', () => {
  const r = parseTokenAdjustBody(undefined);
  assert.deepEqual(r, { ok: false, error: INVALID_BODY_ERR });
});

test('token: string body -> falls through to amount check (route did not throw)', () => {
  const r = parseTokenAdjustBody('not an object');
  assert.deepEqual(r, { ok: false, error: TOKEN_AMOUNT_ERR });
});

test('token: array body -> falls through to amount check', () => {
  const r = parseTokenAdjustBody([1, 2, 3]);
  assert.deepEqual(r, { ok: false, error: TOKEN_AMOUNT_ERR });
});

test('token: number body -> falls through to amount check', () => {
  const r = parseTokenAdjustBody(42);
  assert.deepEqual(r, { ok: false, error: TOKEN_AMOUNT_ERR });
});

// ===========================================================================
// parseBudgetBody
// ===========================================================================

test('budget: valid number budget', () => {
  const r = parseBudgetBody({ provider: 'openai', monthlyBudgetUsd: 5000 });
  assert.deepEqual(r, {
    ok: true,
    value: { provider: 'openai', monthlyBudgetUsd: 5000 },
  });
});

test('budget: null budget (deletion) is accepted', () => {
  const r = parseBudgetBody({ provider: 'openai', monthlyBudgetUsd: null });
  assert.deepEqual(r, {
    ok: true,
    value: { provider: 'openai', monthlyBudgetUsd: null },
  });
});

test('budget: zero budget (lower boundary) is accepted', () => {
  const r = parseBudgetBody({ provider: 'openai', monthlyBudgetUsd: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.value.monthlyBudgetUsd, 0);
});

test('budget: boundary 1000000 is accepted', () => {
  const r = parseBudgetBody({
    provider: 'openai',
    monthlyBudgetUsd: 1000000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.monthlyBudgetUsd, 1000000);
});

test('budget: negative budget is rejected', () => {
  const r = parseBudgetBody({ provider: 'openai', monthlyBudgetUsd: -1 });
  assert.deepEqual(r, { ok: false, error: BUDGET_RANGE_ERR });
});

test('budget: > 1000000 is rejected', () => {
  const r = parseBudgetBody({
    provider: 'openai',
    monthlyBudgetUsd: 1000001,
  });
  assert.deepEqual(r, { ok: false, error: BUDGET_RANGE_ERR });
});

test('budget: NaN is rejected (not finite)', () => {
  const r = parseBudgetBody({ provider: 'openai', monthlyBudgetUsd: NaN });
  assert.deepEqual(r, { ok: false, error: BUDGET_RANGE_ERR });
});

test('budget: Infinity is rejected (not finite)', () => {
  const r = parseBudgetBody({
    provider: 'openai',
    monthlyBudgetUsd: Infinity,
  });
  assert.deepEqual(r, { ok: false, error: BUDGET_RANGE_ERR });
});

test('budget: -Infinity is rejected', () => {
  const r = parseBudgetBody({
    provider: 'openai',
    monthlyBudgetUsd: -Infinity,
  });
  assert.deepEqual(r, { ok: false, error: BUDGET_RANGE_ERR });
});

test('budget: string number "5000" is rejected (no coercion)', () => {
  const r = parseBudgetBody({ provider: 'openai', monthlyBudgetUsd: '5000' });
  assert.deepEqual(r, { ok: false, error: BUDGET_RANGE_ERR });
});

test('budget: missing monthlyBudgetUsd (undefined) is rejected', () => {
  const r = parseBudgetBody({ provider: 'openai' });
  assert.deepEqual(r, { ok: false, error: BUDGET_RANGE_ERR });
});

test('budget: provider missing is rejected', () => {
  const r = parseBudgetBody({ monthlyBudgetUsd: 5000 });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('budget: empty provider is rejected', () => {
  const r = parseBudgetBody({ provider: '', monthlyBudgetUsd: 5000 });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('budget: whitespace-only provider is rejected', () => {
  const r = parseBudgetBody({ provider: '   ', monthlyBudgetUsd: 5000 });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('budget: non-string provider is rejected', () => {
  const r = parseBudgetBody({ provider: 42, monthlyBudgetUsd: 5000 });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('budget: provider check runs before budget check', () => {
  // Bad provider AND bad budget -> provider error wins, matching route order.
  const r = parseBudgetBody({ provider: '', monthlyBudgetUsd: -5 });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('budget: provider is passed through un-normalized (route defers casing to data layer)', () => {
  // The route does not lowercase/trim provider itself; upsertProviderBudget does.
  const r = parseBudgetBody({ provider: '  OpenAI  ', monthlyBudgetUsd: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.value.provider, '  OpenAI  ');
});

test('budget: null body -> Invalid request body (route threw on property access)', () => {
  const r = parseBudgetBody(null);
  assert.deepEqual(r, { ok: false, error: INVALID_BODY_ERR });
});

test('budget: undefined body -> Invalid request body', () => {
  const r = parseBudgetBody(undefined);
  assert.deepEqual(r, { ok: false, error: INVALID_BODY_ERR });
});

test('budget: string body -> falls through to provider check', () => {
  const r = parseBudgetBody('nope');
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('budget: array body -> falls through to provider check', () => {
  const r = parseBudgetBody([]);
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('budget: number body -> falls through to provider check', () => {
  const r = parseBudgetBody(7);
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

// ===========================================================================
// isMissingFunctionError
// ===========================================================================

test('isMissingFunctionError: 42883 (undefined_function) is missing', () => {
  assert.equal(isMissingFunctionError({ code: '42883' }), true);
});

test('isMissingFunctionError: PGRST202 (PostgREST no-match) is missing', () => {
  assert.equal(isMissingFunctionError({ code: 'PGRST202' }), true);
});

test('isMissingFunctionError: unrelated code is not missing', () => {
  assert.equal(isMissingFunctionError({ code: '42P01' }), false);
  assert.equal(isMissingFunctionError({ code: '23505' }), false);
  assert.equal(isMissingFunctionError({}), false);
});

// ===========================================================================
// parseKeySetBody
// ===========================================================================

test('keySet: valid body', () => {
  const r = parseKeySetBody({ provider: 'openai', apiKey: 'sk-abcd1234' });
  assert.deepEqual(r, {
    ok: true,
    value: { provider: 'openai', apiKey: 'sk-abcd1234' },
  });
});

test('keySet: surrounding whitespace is trimmed on the accepted value', () => {
  const r = parseKeySetBody({ provider: 'openai', apiKey: '  sk-abcd1234  ' });
  assert.equal(r.ok, true);
  assert.equal(r.value.apiKey, 'sk-abcd1234');
});

test('keySet: boundary 8-char key is accepted', () => {
  const r = parseKeySetBody({ provider: 'openai', apiKey: 'abcdefgh' });
  assert.equal(r.ok, true);
  assert.equal(r.value.apiKey, 'abcdefgh');
});

test('keySet: boundary 512-char key is accepted', () => {
  const key = 'a'.repeat(512);
  const r = parseKeySetBody({ provider: 'openai', apiKey: key });
  assert.equal(r.ok, true);
  assert.equal(r.value.apiKey, key);
});

test('keySet: 7-char key (under min) is rejected', () => {
  const r = parseKeySetBody({ provider: 'openai', apiKey: 'abcdefg' });
  assert.deepEqual(r, { ok: false, error: KEY_LEN_ERR });
});

test('keySet: 513-char key (over max) is rejected', () => {
  const r = parseKeySetBody({ provider: 'openai', apiKey: 'a'.repeat(513) });
  assert.deepEqual(r, { ok: false, error: KEY_LEN_ERR });
});

test('keySet: whitespace-only key fails the length check (trimmed to empty)', () => {
  const r = parseKeySetBody({ provider: 'openai', apiKey: '          ' });
  assert.deepEqual(r, { ok: false, error: KEY_LEN_ERR });
});

test('keySet: key with internal whitespace is rejected', () => {
  const r = parseKeySetBody({ provider: 'openai', apiKey: 'abcd efgh' });
  assert.deepEqual(r, { ok: false, error: KEY_CHAR_ERR });
});

test('keySet: key with a control character is rejected', () => {
  const key = `abcd${String.fromCharCode(1)}efgh`;
  const r = parseKeySetBody({ provider: 'openai', apiKey: key });
  assert.deepEqual(r, { ok: false, error: KEY_CHAR_ERR });
});

test('keySet: key with a DEL (0x7f) character is rejected', () => {
  const key = `abcd${String.fromCharCode(127)}efgh`;
  const r = parseKeySetBody({ provider: 'openai', apiKey: key });
  assert.deepEqual(r, { ok: false, error: KEY_CHAR_ERR });
});

test('keySet: non-string apiKey is rejected', () => {
  const r = parseKeySetBody({ provider: 'openai', apiKey: 12345678 });
  assert.deepEqual(r, { ok: false, error: KEY_MISSING_ERR });
});

test('keySet: missing apiKey is rejected', () => {
  const r = parseKeySetBody({ provider: 'openai' });
  assert.deepEqual(r, { ok: false, error: KEY_MISSING_ERR });
});

test('keySet: missing provider is rejected', () => {
  const r = parseKeySetBody({ apiKey: 'sk-abcd1234' });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keySet: empty provider is rejected', () => {
  const r = parseKeySetBody({ provider: '', apiKey: 'sk-abcd1234' });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keySet: whitespace-only provider is rejected', () => {
  const r = parseKeySetBody({ provider: '   ', apiKey: 'sk-abcd1234' });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keySet: non-string provider is rejected', () => {
  const r = parseKeySetBody({ provider: 42, apiKey: 'sk-abcd1234' });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keySet: provider check runs before apiKey check', () => {
  // Bad provider AND bad key -> provider error wins.
  const r = parseKeySetBody({ provider: '', apiKey: 'x' });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keySet: provider is passed through un-normalized', () => {
  const r = parseKeySetBody({ provider: '  OpenAI  ', apiKey: 'sk-abcd1234' });
  assert.equal(r.ok, true);
  assert.equal(r.value.provider, '  OpenAI  ');
});

test('keySet: null body -> Invalid request body', () => {
  const r = parseKeySetBody(null);
  assert.deepEqual(r, { ok: false, error: INVALID_BODY_ERR });
});

test('keySet: undefined body -> Invalid request body', () => {
  const r = parseKeySetBody(undefined);
  assert.deepEqual(r, { ok: false, error: INVALID_BODY_ERR });
});

test('keySet: string body -> falls through to provider check', () => {
  const r = parseKeySetBody('nope');
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keySet: array body -> falls through to provider check', () => {
  const r = parseKeySetBody([]);
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keySet: number body -> falls through to provider check', () => {
  const r = parseKeySetBody(7);
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

// ===========================================================================
// parseKeyDeleteBody
// ===========================================================================

test('keyDelete: valid body', () => {
  const r = parseKeyDeleteBody({ provider: 'fal' });
  assert.deepEqual(r, { ok: true, value: { provider: 'fal' } });
});

test('keyDelete: extra fields are ignored', () => {
  const r = parseKeyDeleteBody({ provider: 'fal', apiKey: 'ignored' });
  assert.deepEqual(r, { ok: true, value: { provider: 'fal' } });
});

test('keyDelete: missing provider is rejected', () => {
  const r = parseKeyDeleteBody({});
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keyDelete: empty provider is rejected', () => {
  const r = parseKeyDeleteBody({ provider: '' });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keyDelete: whitespace-only provider is rejected', () => {
  const r = parseKeyDeleteBody({ provider: '   ' });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keyDelete: non-string provider is rejected', () => {
  const r = parseKeyDeleteBody({ provider: 42 });
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keyDelete: provider is passed through un-normalized', () => {
  const r = parseKeyDeleteBody({ provider: '  Fal  ' });
  assert.equal(r.ok, true);
  assert.equal(r.value.provider, '  Fal  ');
});

test('keyDelete: null body -> Invalid request body', () => {
  const r = parseKeyDeleteBody(null);
  assert.deepEqual(r, { ok: false, error: INVALID_BODY_ERR });
});

test('keyDelete: undefined body -> Invalid request body', () => {
  const r = parseKeyDeleteBody(undefined);
  assert.deepEqual(r, { ok: false, error: INVALID_BODY_ERR });
});

test('keyDelete: string body -> falls through to provider check', () => {
  const r = parseKeyDeleteBody('nope');
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keyDelete: array body -> falls through to provider check', () => {
  const r = parseKeyDeleteBody([]);
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});

test('keyDelete: number body -> falls through to provider check', () => {
  const r = parseKeyDeleteBody(7);
  assert.deepEqual(r, { ok: false, error: PROVIDER_ERR });
});
