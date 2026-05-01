import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migrationSql = readFileSync(
  new URL('./20260501120000_grant_simon_derman_tokens.sql', import.meta.url),
  'utf8',
);

assert.match(migrationSql, /simon\.derman@gmail\.com/);
assert.match(
  migrationSql,
  /afe18369-c014-435b-8f1c-bbbb412e3cd2/,
);
assert.match(
  migrationSql,
  /public\.credit_purchased_tokens\(\s*v_user_id,\s*1000,\s*'manual_grant_simon_derman_20260501'\s*\)/,
);
assert.match(
  migrationSql,
  /NOT EXISTS \(\s*SELECT 1\s+FROM public\.token_transactions\s+WHERE reference_id = 'manual_grant_simon_derman_20260501'\s*\)/,
);
