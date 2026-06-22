import {
  getUploadSizeLimitBytes,
  type CostControlPlanLevel,
} from '../../shared/costControls.ts';

export { getUploadSizeLimitBytes };

export function formatUploadSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

export function isUploadTooLarge(
  file: Pick<File, 'size'>,
  plan: CostControlPlanLevel,
): boolean {
  return file.size > getUploadSizeLimitBytes(plan);
}
