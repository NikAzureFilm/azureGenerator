export function getActiveSidebarConversationId(pathname: string) {
  const pathOnly = pathname.split(/[?#]/)[0] ?? '';
  const normalizedPath = pathOnly.replace(/\/+$/, '');
  const match = normalizedPath.match(/^\/editor\/([^/]+)$/);

  if (!match) {
    return undefined;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
