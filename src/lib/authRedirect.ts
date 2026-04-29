const normalizedBasePath = () => {
  const base = import.meta.env.BASE_URL || '/';
  return base.endsWith('/') ? base : `${base}/`;
};

export const authRedirectUrl = (path = '/') => {
  const relativePath = path.startsWith('/') ? path.slice(1) : path;
  return new URL(
    `${normalizedBasePath()}${relativePath}`,
    window.location.origin,
  ).href;
};
