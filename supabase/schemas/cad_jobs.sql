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

ALTER TABLE "public"."cad_jobs" ADD CONSTRAINT "cad_jobs_pkey" PRIMARY KEY USING INDEX "cad_jobs_pkey";

ALTER TABLE "public"."cad_jobs" ADD CONSTRAINT "cad_jobs_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

ALTER TABLE "public"."cad_jobs" VALIDATE CONSTRAINT "cad_jobs_conversation_id_fkey";

ALTER TABLE "public"."cad_jobs" ADD CONSTRAINT "cad_jobs_message_id_fkey" FOREIGN KEY (message_id) REFERENCES messages(id) ON UPDATE CASCADE ON DELETE SET NULL not valid;

ALTER TABLE "public"."cad_jobs" VALIDATE CONSTRAINT "cad_jobs_message_id_fkey";

ALTER TABLE "public"."cad_jobs" ADD CONSTRAINT "cad_jobs_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

ALTER TABLE "public"."cad_jobs" VALIDATE CONSTRAINT "cad_jobs_user_id_fkey";


CREATE INDEX IF NOT EXISTS idx_cad_jobs_user_created ON "public"."cad_jobs" USING btree (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cad_jobs_user_status_created ON "public"."cad_jobs" USING btree (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cad_jobs_conversation_created ON "public"."cad_jobs" USING btree (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cad_jobs_status_created ON "public"."cad_jobs" USING btree (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cad_jobs_worker_request_id ON "public"."cad_jobs" USING btree (worker_request_id) WHERE (worker_request_id IS NOT NULL);


CREATE POLICY "Everyone can view CAD jobs associated with public conversations" ON "public"."cad_jobs" FOR SELECT TO "authenticated", "anon" USING ((EXISTS ( SELECT 1
   FROM "public"."conversations"
  WHERE (("conversations"."id" = "cad_jobs"."conversation_id") AND ("conversations"."privacy" = 'public'::"public"."privacy_type")))));

CREATE POLICY "Users can manage their CAD jobs" ON "public"."cad_jobs" USING ( (SELECT "auth"."uid"()) = "user_id" );

ALTER TABLE "public"."cad_jobs" ENABLE ROW LEVEL SECURITY;
