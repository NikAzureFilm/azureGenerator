CREATE TABLE IF NOT EXISTS "public"."cad_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "public"."generation-status" DEFAULT 'pending'::"public"."generation-status" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "message_id" "uuid",
    "prompt" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "artifacts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "worker_request_id" "text",
    "error" "text"
);

CREATE UNIQUE INDEX IF NOT EXISTS cad_jobs_pkey ON "public"."cad_jobs" USING btree (id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cad_jobs_pkey'
  ) THEN
    ALTER TABLE "public"."cad_jobs" ADD CONSTRAINT "cad_jobs_pkey" PRIMARY KEY USING INDEX "cad_jobs_pkey";
  END IF;
END $$;

ALTER TABLE "public"."cad_jobs"
  ADD CONSTRAINT "cad_jobs_conversation_id_fkey"
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE "public"."cad_jobs" VALIDATE CONSTRAINT "cad_jobs_conversation_id_fkey";

ALTER TABLE "public"."cad_jobs"
  ADD CONSTRAINT "cad_jobs_message_id_fkey"
  FOREIGN KEY (message_id) REFERENCES messages(id)
  ON UPDATE CASCADE ON DELETE SET NULL NOT VALID;
ALTER TABLE "public"."cad_jobs" VALIDATE CONSTRAINT "cad_jobs_message_id_fkey";

ALTER TABLE "public"."cad_jobs"
  ADD CONSTRAINT "cad_jobs_user_id_fkey"
  FOREIGN KEY (user_id) REFERENCES auth.users(id)
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE "public"."cad_jobs" VALIDATE CONSTRAINT "cad_jobs_user_id_fkey";

ALTER TABLE "public"."cad_jobs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone can view CAD jobs associated with public conversations"
ON "public"."cad_jobs" FOR SELECT TO "authenticated", "anon"
USING (
  EXISTS (
    SELECT 1
    FROM "public"."conversations"
    WHERE "conversations"."id" = "cad_jobs"."conversation_id"
      AND "conversations"."privacy" = 'public'::"public"."privacy_type"
  )
);

CREATE POLICY "Users can manage their CAD jobs"
ON "public"."cad_jobs"
USING ((SELECT "auth"."uid"()) = "user_id");

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cad-artifacts',
  'cad-artifacts',
  false,
  104857600,
  ARRAY[
    'model/step',
    'application/step',
    'application/octet-stream',
    'model/gltf-binary',
    'model/stl',
    'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    'text/x-python',
    'text/plain'
  ]
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Give users access to own folder cad_artifacts_select"
ON storage.objects FOR SELECT TO public
USING (
  bucket_id = 'cad-artifacts'
  AND (SELECT auth.uid()::text) = (storage.foldername(name))[1]
);

CREATE POLICY "Give users access to own folder cad_artifacts_insert"
ON storage.objects FOR INSERT TO public
WITH CHECK (
  bucket_id = 'cad-artifacts'
  AND (SELECT auth.uid()::text) = (storage.foldername(name))[1]
);

CREATE POLICY "Give users access to own folder cad_artifacts_update"
ON storage.objects FOR UPDATE TO public
USING (
  bucket_id = 'cad-artifacts'
  AND (SELECT auth.uid()::text) = (storage.foldername(name))[1]
);

CREATE POLICY "Give users access to own folder cad_artifacts_delete"
ON storage.objects FOR DELETE TO public
USING (
  bucket_id = 'cad-artifacts'
  AND (SELECT auth.uid()::text) = (storage.foldername(name))[1]
);

CREATE POLICY "Public conversations allow anyone to view cad_artifacts_select"
ON storage.objects FOR SELECT TO anon, authenticated
USING (
  bucket_id = 'cad-artifacts'
  AND EXISTS (
    SELECT 1
    FROM conversations
    WHERE conversations.privacy = 'public'
      AND conversations.id::text = (storage.foldername(objects.name))[2]
  )
);
