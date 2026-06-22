CREATE TYPE "public"."conversation-type" AS ENUM (
    'parametric',
    'creative'
);

CREATE TYPE "public"."generation-status" AS ENUM (
    'pending',
    'success',
    'failure'
);

CREATE TYPE "public"."mesh_model_type" AS ENUM (
    'quality',
    'fast'
);

CREATE TYPE "public"."mesh_file_type" AS ENUM (
    'glb',
    'stl',
    'obj',
    'fbx'
);

CREATE TYPE "public"."privacy_type" AS ENUM (
    'public',
    'private'
);

CREATE TYPE "public"."prompt_type" AS ENUM (
    'mesh',
    'image',
    'chat'
);

CREATE TYPE "public"."stripe-level" AS ENUM (
    'pro',
    'standard',
    'max'
);

CREATE TYPE "public"."subscription_level" AS ENUM (
    'pro',
    'standard',
    'max',
    'free'
);

CREATE TYPE "public"."token_operation_type" AS ENUM (
    'mesh',
    'parametric',
    'chat',
    'refund'
);

CREATE TYPE "public"."token_source_type" AS ENUM (
    'subscription',
    'purchased'
);

CREATE TYPE "public"."user_data" AS (
	"hasTrialed" boolean,
	"sublevel" "public"."subscription_level",
	"subscriptionTokens" integer,
	"purchasedTokens" integer,
	"totalTokens" integer,
	"subscriptionTokenLimit" integer,
	"subscriptionExpiresAt" timestamptz
);
