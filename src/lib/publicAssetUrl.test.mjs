import assert from 'node:assert/strict';
import { publicAssetUrl } from './publicAssetUrl.ts';

assert.equal(publicAssetUrl('/', 'city.hdr'), '/city.hdr');
assert.equal(publicAssetUrl('/cad/', 'city.hdr'), '/cad/city.hdr');
assert.equal(
  publicAssetUrl('/cad', '/libraries/BOSL.zip'),
  '/cad/libraries/BOSL.zip',
);
