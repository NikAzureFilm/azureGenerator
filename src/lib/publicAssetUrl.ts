export function publicAssetUrl(baseUrl: string, assetPath: string) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}${assetPath.replace(/^\/+/, '')}`;
}

export function vitePublicAssetUrl(assetPath: string) {
  return publicAssetUrl(import.meta.env.BASE_URL, assetPath);
}
