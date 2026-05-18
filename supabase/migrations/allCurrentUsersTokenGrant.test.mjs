import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migrationSql = readFileSync(
  new URL('./20260518081800_grant_current_users_3000_tokens.sql', import.meta.url),
  'utf8',
);

assert.match(migrationSql, /FROM auth\.users/);
assert.match(
  migrationSql,
  /reference_id = v_reference_id/,
  'grant is idempotent per user reference',
);
assert.match(
  migrationSql,
  /public\.credit_purchased_tokens\(\s*v_user\.id,\s*3000,\s*v_reference_id\s*\)/,
);
assert.match(
  migrationSql,
  /manual_grant_all_current_users_3000_20260518/,
);
