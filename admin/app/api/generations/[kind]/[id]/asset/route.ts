import { NextResponse, type NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth';
import {
  fetchGenerationDetail,
  isGenerationKind,
  resolveGenerationAsset,
} from '@/lib/generations';

export const dynamic = 'force-dynamic';

// Streams a generation output (3D model, image, CAD source) to the admin.
// GET /api/generations/:kind/:id/asset?type=model[&download=1]
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { kind, id } = await params;
  if (!isGenerationKind(kind)) {
    return NextResponse.json({ error: 'Unknown kind' }, { status: 400 });
  }

  const type = req.nextUrl.searchParams.get('type') ?? '';
  if (!type) {
    return NextResponse.json({ error: 'Missing type' }, { status: 400 });
  }

  const detail = await fetchGenerationDetail(kind, id);
  if (!detail) {
    return NextResponse.json(
      { error: 'Generation not found' },
      { status: 404 },
    );
  }

  const download = req.nextUrl.searchParams.get('download') === '1';

  let asset;
  try {
    asset = await resolveGenerationAsset(detail, type, download);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to fetch asset';
    return NextResponse.json({ error: message }, { status: 502 });
  }
  if (!asset) {
    return NextResponse.json({ error: 'Asset not available' }, { status: 404 });
  }

  // Storage-backed assets: send the browser straight to a signed URL so big
  // mesh files never flow through this function.
  if (asset.kind === 'redirect') {
    return NextResponse.redirect(asset.url, 302);
  }

  const headers = new Headers({
    'Content-Type': asset.contentType,
    // Outputs are immutable once a job succeeds; let the browser cache them
    // for the session so the viewer doesn't refetch on every visit.
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${asset.filename}"`,
  });
  if (asset.body instanceof Blob) {
    headers.set('Content-Length', String(asset.body.size));
  }

  return new Response(asset.body, { headers });
}
