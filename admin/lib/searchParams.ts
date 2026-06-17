// Helpers for building /users URLs that preserve search/sort/pagination state.

export type UsersQuery = {
  q?: string;
  sort: string;
  order: 'asc' | 'desc';
  page: number;
};

// Build a /users href, overriding any subset of the current query state.
export function usersHref(
  current: UsersQuery,
  patch: Partial<UsersQuery>,
): string {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.sort && next.sort !== 'last_active') params.set('sort', next.sort);
  if (next.order && next.order !== 'desc') params.set('order', next.order);
  if (next.page && next.page > 1) params.set('page', String(next.page));
  const qs = params.toString();
  return qs ? `/users?${qs}` : '/users';
}

// A sortable column header href: clicking the active column flips order,
// clicking another column sorts it desc. Always resets to page 1.
export function sortHref(current: UsersQuery, col: string): string {
  const isActive = current.sort === col;
  const order: 'asc' | 'desc' =
    isActive && current.order === 'desc' ? 'asc' : 'desc';
  return usersHref(current, { sort: col, order, page: 1 });
}
