import assert from 'node:assert/strict';
import {
  UPLOAD_SIZE_LIMITS_BYTES,
  getUploadSizeLimitBytes,
} from '../../shared/costControls.ts';
import { formatUploadSize, isUploadTooLarge } from './uploadLimits.ts';

assert.equal(
  getUploadSizeLimitBytes('free'),
  25 * 1024 * 1024,
  'free users should be capped at 25MB uploads',
);

assert.equal(
  getUploadSizeLimitBytes('standard'),
  50 * 1024 * 1024,
  'standard users should be capped at 50MB uploads',
);

assert.equal(
  getUploadSizeLimitBytes('pro'),
  UPLOAD_SIZE_LIMITS_BYTES.max,
  'pro and max plans should share the 100MB upload ceiling',
);

assert.equal(formatUploadSize(25 * 1024 * 1024), '25MB');
assert.equal(isUploadTooLarge({ size: 26 * 1024 * 1024 }, 'free'), true);
assert.equal(isUploadTooLarge({ size: 26 * 1024 * 1024 }, 'standard'), false);

console.log('upload limit helper tests passed');
