import Link from 'next/link';

export default function UserNotFound() {
  return (
    <div className="wrap">
      <div className="card" style={{ marginTop: 40 }}>
        <div className="value" style={{ fontSize: 20 }}>
          User not found
        </div>
        <div className="sub" style={{ marginTop: 8 }}>
          No user exists with that id, or they have no profile.
        </div>
        <div style={{ marginTop: 16 }}>
          <Link className="btn" href="/users">
            ← Back to users
          </Link>
        </div>
      </div>
    </div>
  );
}
