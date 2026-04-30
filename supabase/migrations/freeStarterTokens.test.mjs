import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migrationSql = readFileSync(
  new URL('./20260430090000_set_free_starter_tokens_to_100.sql', import.meta.url),
  'utf8',
);

assert.match(
  migrationSql,
  /VALUES \(NEW\.id, 'purchased'::public\.token_source_type, 100\);/,
);
assert.match(migrationSql, /SET balance = LEAST\(tb\.balance, 100\)/);
assert.match(migrationSql, /tt\.amount > 0/);
