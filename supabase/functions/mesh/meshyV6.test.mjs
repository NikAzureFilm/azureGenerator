import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /const MESHY_V6_IMAGE_TO_3D_ENDPOINT = 'fal-ai\/meshy\/v6-preview\/image-to-3d';/,
  'Max Quality should submit to Meshy 6 Preview image-to-3D',
);

assert.match(
  source,
  /const MESHY_V6_MAX_TARGET_POLYCOUNT = 300000;/,
  'Meshy 6 Preview Max Quality should know the 300k polygon cap',
);

assert.match(
  source,
  /model_type: 'standard' as const,[\s\S]*target_polycount: safePolycount,[\s\S]*should_remesh: true,[\s\S]*should_texture: true,[\s\S]*enable_pbr: false,/,
  'Meshy 6 Preview payload should request standard remeshed textured output',
);

assert.match(
  source,
  /: MESHY_V6_MAX_TARGET_POLYCOUNT;/,
  'Max Quality should default Meshy target_polycount to the 300k cap',
);
