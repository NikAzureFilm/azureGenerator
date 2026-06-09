import { requireAdmin } from '@/lib/auth';
import { getResourceGroups } from '@/lib/resourceLinks';
import Nav from '@/app/components/Nav';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ResourcesPage() {
  const admin = await requireAdmin();
  const groups = getResourceGroups();

  return (
    <div className="wrap">
      <Nav active="resources" email={admin.email} />

      <div className="section-title">Operations links</div>
      <div className="resource-grid">
        {groups.map((group) => (
          <section className="card resource-section" key={group.title}>
            <div className="label">{group.title}</div>
            <div className="resource-list">
              {group.links.map((link) => (
                <a
                  className="resource-link"
                  href={link.href}
                  key={`${group.title}-${link.label}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  <span>{link.label}</span>
                  <small>{link.description}</small>
                </a>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
