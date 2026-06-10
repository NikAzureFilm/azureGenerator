// One-off sanity check for the generation asset plumbing.
// Verifies: mesh storage path, image storage path, CAD artifact URL shape.
// Run: node scripts/verify-generation-assets.mjs   (reads .env.local)
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const supa = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const out = (label, value) => console.log(`${label}: ${value}`);

// --- mesh -------------------------------------------------------------
const { data: meshes } = await supa
  .from('meshes')
  .select('id,user_id,conversation_id,file_type,status')
  .eq('status', 'success')
  .order('created_at', { ascending: false })
  .limit(3);
for (const m of meshes ?? []) {
  const path = `${m.user_id}/${m.conversation_id}/${m.id}.${m.file_type}`;
  const { data, error } = await supa.storage.from('meshes').download(path);
  out(
    `mesh ${m.id.slice(0, 8)} (${m.file_type})`,
    error ? `FAIL ${error.message}` : `OK ${data.size} bytes`,
  );
}
if (!meshes?.length) out('mesh', 'no success rows');

// --- image ------------------------------------------------------------
const { data: images } = await supa
  .from('images')
  .select('id,user_id,conversation_id,status')
  .eq('status', 'success')
  .order('created_at', { ascending: false })
  .limit(2);
for (const im of images ?? []) {
  const path = `${im.user_id}/${im.conversation_id}/${im.id}`;
  const { data, error } = await supa.storage.from('images').download(path);
  out(
    `image ${im.id.slice(0, 8)}`,
    error
      ? `FAIL ${error.message}`
      : `OK ${data.size} bytes type=${data.type || 'n/a'}`,
  );
}
if (!images?.length) out('image', 'no success rows');

// --- cad --------------------------------------------------------------
const { data: cads } = await supa
  .from('cad_jobs')
  .select('id,status,artifacts')
  .eq('status', 'success')
  .order('created_at', { ascending: false })
  .limit(3);
for (const job of cads ?? []) {
  const artifacts = job.artifacts ?? {};
  const keys = Object.keys(artifacts);
  out(`cad ${job.id.slice(0, 8)} keys`, keys.join(',') || 'none');
  for (const key of keys) {
    const value = String(artifacts[key]);
    const isUrl = /^https?:\/\//i.test(value);
    let status = isUrl ? 'url' : 'path';
    if (isUrl) {
      try {
        const res = await fetch(value, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        });
        const len = res.headers.get('content-length') ?? '?';
        status = `url ${new URL(value).host} -> HTTP ${res.status} (${len} bytes)`;
        res.body?.cancel();
      } catch (e) {
        status = `url ${new URL(value).host} -> UNREACHABLE (${e.name})`;
      }
    } else {
      const path = value.replace(/^\/+/, '').replace(/^cad-artifacts\//, '');
      const { data, error } = await supa.storage
        .from('cad-artifacts')
        .download(path);
      status = error
        ? `bucket path FAIL ${error.message}`
        : `bucket path OK ${data.size} bytes`;
    }
    out(`  ${key}`, status);
  }
}
if (!cads?.length) out('cad', 'no success rows');
