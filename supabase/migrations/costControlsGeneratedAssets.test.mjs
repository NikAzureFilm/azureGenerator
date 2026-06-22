import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL(
    './20260622124225_cost_controls_generated_assets.sql',
    import.meta.url,
  ),
  'utf8',
);

assert.match(
  migration,
  /create table if not exists public\.generation_assets/i,
  'migration should create generated-asset metadata',
);

assert.match(
  migration,
  /provider in \('r2', 'supabase'\)/i,
  'metadata should support R2 and Supabase fallback providers',
);

assert.match(
  migration,
  /create or replace function public\.cleanup_expired_generation_assets/i,
  'migration should add expired generated-asset cleanup',
);

assert.match(
  migration,
  /file_size_limit = excluded\.file_size_limit/i,
  'migration should enforce storage bucket upload ceilings',
);

assert.match(
  migration,
  /idx_token_transactions_user_operation_created/i,
  'migration should add token transaction indexes for daily limit checks',
);

assert.match(
  migration,
  /idx_cad_jobs_user_status_created/i,
  'migration should add active CAD job indexes',
);

assert.match(
  migration,
  /add value if not exists 'max'/i,
  'migration should bring the database enum in line with the max plan',
);

console.log('cost-controls generated-assets migration tests passed');
