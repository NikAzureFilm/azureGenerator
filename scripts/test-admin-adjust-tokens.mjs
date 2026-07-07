import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const repoRoot = process.cwd();
const testFile = path.join(repoRoot, 'supabase', 'tests', 'admin_adjust_tokens.test.sql');
const enumMigrationFile = path.join(repoRoot, 'supabase', 'migrations', '20260707120100_token_admin_adjustment_enum.sql');
const rpcMigrationFile = path.join(repoRoot, 'supabase', 'migrations', '20260707120200_admin_adjust_tokens_rpc.sql');

const localDb = {
  host: '127.0.0.1',
  port: 54322,
  user: 'postgres',
  password: 'postgres',
};

function createClient(database = 'postgres') {
  return new pg.Client({
    ...localDb,
    database,
    connectionTimeoutMillis: 3000,
  });
}

function collectTapLines(results) {
  const resultList = Array.isArray(results) ? results : [results];
  const lines = [];

  for (const result of resultList) {
    if (result.fields.length !== 1) {
      continue;
    }

    for (const row of result.rows) {
      const value = row[result.fields[0].name];
      if (typeof value === 'string') {
        lines.push(value);
      }
    }
  }

  return lines;
}

function validateTap(lines) {
  const planLine = lines.find((line) => /^1\.\.\d+$/.test(line));
  const assertionLines = lines.filter((line) => /^(?:not )?ok\b/.test(line));
  const failedLines = lines.filter((line) => /^not ok\b/.test(line));

  if (!planLine) {
    return { ok: false, error: 'missing TAP plan line' };
  }

  const planned = Number(planLine.slice(3));
  if (assertionLines.length !== planned) {
    return {
      ok: false,
      error: `planned ${planned} assertions but saw ${assertionLines.length}`,
    };
  }

  if (failedLines.length > 0) {
    return {
      ok: false,
      error: `${failedLines.length} assertion(s) failed`,
    };
  }

  return { ok: true, planned };
}

function quoteIdent(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function probeLocalDatabase() {
  const client = createClient();

  try {
    await client.connect();
    await client.query('select 1');
    console.log('Local Supabase DB reachable: postgresql://postgres:postgres@127.0.0.1:54322/postgres');
    return true;
  } catch (error) {
    console.error('Local Supabase DB is not reachable at 127.0.0.1:54322 with postgres/postgres.');
    console.error('Cold-start it from the repo root with:');
    console.error('npx supabase start');
    console.error('Then rerun: node .\\scripts\\test-admin-adjust-tokens.mjs');
    console.error(`Connection error: ${error.message}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function runTests() {
  const sql = await fs.readFile(testFile, 'utf8');
  const client = createClient();

  console.log('Running admin_adjust_tokens pgTAP tests');
  console.log('Database: postgresql://postgres:postgres@127.0.0.1:54322/postgres');
  console.log(`Test file: ${path.relative(repoRoot, testFile)}`);

  await client.connect();
  const results = await client.query(sql);
  const tapLines = collectTapLines(results);

  for (const line of tapLines) {
    console.log(line);
  }

  const validation = validateTap(tapLines);
  if (!validation.ok) {
    console.error(`TAP validation failed: ${validation.error}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS admin_adjust_tokens.test.sql (${validation.planned} assertions)`);
  }
  await client.end().catch(() => {});
}

async function runOrderingProof() {
  const client = createClient();
  const proof = [];
  const record = (ok, message, detail) => {
    proof.push(ok);
    console.log(`${ok ? 'ok' : 'not ok'} ${proof.length} - ${message}`);
    if (detail) {
      console.log(`# ${detail}`);
    }
  };

  await client.connect();

  try {
    const enumSql = await fs.readFile(enumMigrationFile, 'utf8');
    const rpcSql = await fs.readFile(rpcMigrationFile, 'utf8');

    console.log('Ordering proof: positive ordered replay');
    await client.query(enumSql);
    record(true, '20260707120100 enum add ran as its own committed statement');

    try {
      await client.query('begin');
      await client.query(rpcSql);
      await client.query('commit');
      record(true, '20260707120200 RPC body ran in a later transaction');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      record(false, '20260707120200 RPC body failed in later transaction', `${error.code ?? 'ERROR'} ${error.message}`);
    }

    const orderedCheck = await client.query(`
      select
        exists (
          select 1
          from pg_type t
          join pg_enum e on e.enumtypid = t.oid
          join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public'
            and t.typname = 'token_operation_type'
            and e.enumlabel = 'admin_adjustment'
        ) as enum_exists,
        to_regprocedure('public.admin_adjust_tokens(uuid, integer, public.token_source_type, text)') is not null as rpc_exists
    `);
    record(orderedCheck.rows[0].enum_exists, "enum value 'admin_adjustment' exists after ordered replay");
    record(orderedCheck.rows[0].rpc_exists, 'public.admin_adjust_tokens exists after ordered replay');

    console.log('Ordering proof: negative same-transaction boundary');
    const typeName = `tmp_admin_adjust_order_${process.pid}_${Date.now()}`;
    const typeSql = `public.${quoteIdent(typeName)}`;
    let sawUnsafeUse = false;
    let unsafeUseDetail = '';

    try {
      await client.query(`create type ${typeSql} as enum ('base')`);
      await client.query('begin');
      await client.query(`alter type ${typeSql} add value 'x'`);
      try {
        await client.query(`select 'x'::${typeSql}`);
      } catch (error) {
        sawUnsafeUse = error.code === '55P04' && /unsafe use of new value/i.test(error.message);
        unsafeUseDetail = `${error.code ?? 'ERROR'} ${error.message}`;
      } finally {
        await client.query('rollback').catch(() => {});
      }

      record(sawUnsafeUse, 'same-transaction enum add/use is rejected with unsafe-use error', unsafeUseDetail);
    } finally {
      await client.query(`drop type if exists ${typeSql}`).catch((error) => {
        record(false, 'throwaway enum cleanup failed', `${error.code ?? 'ERROR'} ${error.message}`);
      });
    }

    const cleanupCheck = await client.query('select to_regtype($1) is null as cleaned', [`public.${typeName}`]);
    record(cleanupCheck.rows[0].cleaned, 'throwaway enum type left no residue');

    if (proof.every(Boolean)) {
      console.log(`ORDERING PROOF PASS (${proof.length} checks)`);
    } else {
      console.log(`ORDERING PROOF FAIL (${proof.filter(Boolean).length}/${proof.length} checks passed)`);
      process.exitCode = 1;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

try {
  if (!(await probeLocalDatabase())) {
    process.exitCode = 1;
  } else if (process.argv.includes('--ordering-proof')) {
    await runOrderingProof();
  } else {
    await runTests();
  }
} catch (error) {
  console.error('admin_adjust_tokens runner failed');
  console.error(error);
  process.exitCode = 1;
}
