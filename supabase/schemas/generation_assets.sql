CREATE TABLE IF NOT EXISTS "public"."generation_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "conversation_id" "uuid",
    "source_table" "text",
    "source_id" "uuid",
    "kind" "text" NOT NULL,
    "provider" "text" DEFAULT 'r2'::"text" NOT NULL,
    "bucket" "text" NOT NULL,
    "object_key" "text" NOT NULL,
    "mime_type" "text",
    "size_bytes" bigint DEFAULT 0 NOT NULL,
    "visibility" "text" DEFAULT 'private'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "generation_assets_kind_check" CHECK (("kind" = ANY (ARRAY['image'::"text", 'mesh'::"text", 'preview'::"text", 'cad-artifact'::"text", 'temp-multiview'::"text", 'failed-artifact'::"text"]))),
    CONSTRAINT "generation_assets_provider_check" CHECK (("provider" = ANY (ARRAY['r2'::"text", 'supabase'::"text"]))),
    CONSTRAINT "generation_assets_size_bytes_check" CHECK (("size_bytes" >= 0)),
    CONSTRAINT "generation_assets_source_table_check" CHECK ((("source_table" IS NULL) OR ("source_table" = ANY (ARRAY['images'::"text", 'meshes'::"text", 'previews'::"text", 'cad_jobs'::"text"])))),
    CONSTRAINT "generation_assets_visibility_check" CHECK (("visibility" = ANY (ARRAY['private'::"text", 'public'::"text"])))
);


CREATE UNIQUE INDEX IF NOT EXISTS generation_assets_pkey ON "public"."generation_assets" USING btree (id);

ALTER TABLE "public"."generation_assets" ADD CONSTRAINT "generation_assets_pkey" PRIMARY KEY USING INDEX "generation_assets_pkey";

ALTER TABLE "public"."generation_assets" ADD CONSTRAINT "generation_assets_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

ALTER TABLE "public"."generation_assets" VALIDATE CONSTRAINT "generation_assets_user_id_fkey";

ALTER TABLE "public"."generation_assets" ADD CONSTRAINT "generation_assets_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

ALTER TABLE "public"."generation_assets" VALIDATE CONSTRAINT "generation_assets_conversation_id_fkey";


CREATE UNIQUE INDEX IF NOT EXISTS generation_assets_active_object_key_idx ON "public"."generation_assets" USING btree (provider, bucket, object_key) WHERE (deleted_at IS NULL);

CREATE INDEX IF NOT EXISTS generation_assets_conversation_created_idx ON "public"."generation_assets" USING btree (conversation_id, created_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX IF NOT EXISTS generation_assets_expiry_idx ON "public"."generation_assets" USING btree (expires_at) WHERE ((deleted_at IS NULL) AND (expires_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS generation_assets_kind_created_idx ON "public"."generation_assets" USING btree (kind, created_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX IF NOT EXISTS generation_assets_source_idx ON "public"."generation_assets" USING btree (source_table, source_id, created_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX IF NOT EXISTS generation_assets_user_created_idx ON "public"."generation_assets" USING btree (user_id, created_at DESC) WHERE (deleted_at IS NULL);


CREATE POLICY "Public can read shared generated assets" ON "public"."generation_assets" FOR SELECT TO "authenticated", "anon" USING ((visibility = 'public'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."conversations"
  WHERE (("conversations"."id" = "generation_assets"."conversation_id") AND ("conversations"."privacy" = 'public'::"public"."privacy_type")))));

CREATE POLICY "Users can manage their generated assets" ON "public"."generation_assets" TO "authenticated" USING ((( SELECT "auth"."uid"()) = "user_id")) WITH CHECK ((( SELECT "auth"."uid"()) = "user_id"));

ALTER TABLE "public"."generation_assets" ENABLE ROW LEVEL SECURITY;


CREATE OR REPLACE VIEW "public"."generation_asset_usage" AS
 SELECT "user_id",
    (count(*))::bigint AS "asset_count",
    (COALESCE(sum("size_bytes"), (0)::numeric))::bigint AS "storage_bytes",
    (COALESCE(sum("size_bytes") FILTER (WHERE ("provider" = 'r2'::"text")), (0)::numeric))::bigint AS "r2_storage_bytes",
    (COALESCE(sum("size_bytes") FILTER (WHERE ("provider" = 'supabase'::"text")), (0)::numeric))::bigint AS "supabase_storage_bytes",
    (COALESCE(sum("size_bytes") FILTER (WHERE ("kind" = 'temp-multiview'::"text")), (0)::numeric))::bigint AS "temp_storage_bytes",
    max("created_at") AS "latest_asset_at"
   FROM "public"."generation_assets"
  WHERE ("deleted_at" IS NULL)
  GROUP BY "user_id";
