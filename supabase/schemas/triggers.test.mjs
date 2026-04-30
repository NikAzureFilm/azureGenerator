import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const triggersSql = readFileSync(
  new URL('./triggers.sql', import.meta.url),
  'utf8',
);

const handleNewUserMatch = triggersSql.match(
  /CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)[\s\S]*?CREATE OR REPLACE TRIGGER on_auth_user_created/,
);

assert.ok(handleNewUserMatch, 'handle_new_user function is present');

const handleNewUserSql = handleNewUserMatch[0];

assert.match(
  handleNewUserSql,
  /VALUES \(NEW\.id, 'purchased'::public\.token_source_type, 100\);/,
  'new users receive an initial 100 purchased-token starter grant',
);

assert.doesNotMatch(
  handleNewUserSql,
  /'subscription'::public\.token_source_type,\s+\d+,\s+now\(\) \+ interval '1 day'/,
  'new users do not receive recurring free subscription tokens',
);
