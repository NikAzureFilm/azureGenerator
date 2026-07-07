import Link from 'next/link';

// Top bar shared across every admin page: brand, primary nav, signed-in email
// and sign-out. `active` is the key of the current page so its link is
// highlighted. Pure server component.
const LINKS: { key: string; href: string; label: string }[] = [
  { key: 'overview', href: '/', label: 'Overview' },
  { key: 'users', href: '/users', label: 'Users' },
  { key: 'generations', href: '/generations', label: 'Generations' },
  { key: 'costs', href: '/costs', label: 'Costs' },
  { key: 'providers', href: '/providers', label: 'Providers' },
  { key: 'retention', href: '/retention', label: 'Retention' },
  { key: 'resources', href: '/resources', label: 'Resources' },
];

export default function Nav({
  active,
  email,
}: {
  active: string;
  email: string;
}) {
  return (
    <div className="topbar">
      <div className="brand">
        <h1>Adam Admin</h1>
        <span className="tag">analytics</span>
        <nav className="mainnav">
          {LINKS.map((l) => (
            <Link
              key={l.key}
              href={l.href}
              className={l.key === active ? 'navlink active' : 'navlink'}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="userbox">
        <span>{email}</span>
        <form action="/api/logout" method="post">
          <button className="btn" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
