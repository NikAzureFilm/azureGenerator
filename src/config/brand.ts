export const BRAND_NAME = 'AzureFilm Generator';
export const BRAND_COMPANY_NAME = 'AzureFilm';
export const BRAND_WEBSITE = 'https://azurefilm.com';
export const BRAND_CONTACT_EMAIL = 'hello@azurefilm.com';

export function brandAsset(fileName: string) {
  const baseUrl = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;

  return `${baseUrl}${fileName.replace(/^\/+/, '')}`;
}
