-- Private "thumbnails" bucket for small pre-rendered creation preview images.
--
-- The history list and sidebar show a thumbnail per creation. Rendering one
-- for a mesh means downloading the full multi-MB GLB/STL. Storing a ~5KB WebP
-- once lets every later load (and every other device) fetch the small image
-- from storage/CDN instead of re-downloading the mesh — a large reduction in
-- Storage egress at scale.
--
-- Owner-scoped RLS mirrors the "meshes" bucket exactly: the first path segment
-- of the object name must equal the authenticated user's id
-- (e.g. "{user_id}/{conversation_id}/{mesh_id}.webp").

insert into storage.buckets (id, name, public)
values ('thumbnails', 'thumbnails', false)
on conflict (id) do nothing;

drop policy if exists "Give users access to own folder thumbnails_select" on "storage"."objects";
create policy "Give users access to own folder thumbnails_select"
  on "storage"."objects"
  as permissive
  for select
  to public
using (((bucket_id = 'thumbnails'::text) AND (( SELECT (auth.uid())::text AS uid) = (storage.foldername(name))[1])));

drop policy if exists "Give users access to own folder thumbnails_insert" on "storage"."objects";
create policy "Give users access to own folder thumbnails_insert"
  on "storage"."objects"
  as permissive
  for insert
  to public
with check (((bucket_id = 'thumbnails'::text) AND (( SELECT (auth.uid())::text AS uid) = (storage.foldername(name))[1])));

drop policy if exists "Give users access to own folder thumbnails_update" on "storage"."objects";
create policy "Give users access to own folder thumbnails_update"
  on "storage"."objects"
  as permissive
  for update
  to public
using (((bucket_id = 'thumbnails'::text) AND (( SELECT (auth.uid())::text AS uid) = (storage.foldername(name))[1])));

drop policy if exists "Give users access to own folder thumbnails_delete" on "storage"."objects";
create policy "Give users access to own folder thumbnails_delete"
  on "storage"."objects"
  as permissive
  for delete
  to public
using (((bucket_id = 'thumbnails'::text) AND (( SELECT (auth.uid())::text AS uid) = (storage.foldername(name))[1])));
