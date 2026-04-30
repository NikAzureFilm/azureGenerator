import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const functionsSql = readFileSync(
  new URL('./functions.sql', import.meta.url),
  'utf8',
);

const ensureFreeTierFreshMatch = functionsSql.match(
  /CREATE OR REPLACE FUNCTION "public"\."ensure_free_tier_fresh"\("p_user_id" uuid\)[\s\S]*?\$\$;/,
);
const resetFreeTierTokensMatch = functionsSql.match(
  /CREATE OR REPLACE FUNCTION "public"\."reset_free_tier_tokens"\(\)[\s\S]*?\$\$;/,
);

assert.ok(
  ensureFreeTierFreshMatch,
  'ensure_free_tier_fresh function is present',
);
assert.ok(
  resetFreeTierTokensMatch,
  'reset_free_tier_tokens function is present',
);

const ensureFreeTierFreshSql = ensureFreeTierFreshMatch[0];
const resetFreeTierTokensSql = resetFreeTierTokensMatch[0];

assert.match(functionsSql, /-- Free tier\s+RETURN 0;/);
assert.doesNotMatch(
  ensureFreeTierFreshSql,
  /INSERT INTO public\.token_balances/,
  'free-tier freshness checks do not grant recurring tokens',
);
assert.match(
  resetFreeTierTokensSql,
  /SET balance = 0,/,
  'free-tier reset backstop clears recurring free subscription balances',
);
assert.doesNotMatch(
  resetFreeTierTokensSql,
  /SET balance = 100,/,
  'free-tier reset backstop does not grant daily tokens',
);
