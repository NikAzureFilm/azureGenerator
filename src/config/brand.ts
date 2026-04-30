import { vitePublicAssetUrl } from '@/lib/publicAssetUrl';

export const BRAND_NAME = 'AzureFilm Generator';
export const BRAND_COMPANY_NAME = 'AzureFilm';
export const BRAND_WEBSITE = 'https://azurefilm.com';
export const BRAND_CONTACT_EMAIL = 'hello@azurefilm.com';

export function brandAsset(fileName: string) {
  return vitePublicAssetUrl(fileName);
}
