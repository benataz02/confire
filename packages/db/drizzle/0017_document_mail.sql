CREATE TABLE "document_mail" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{"types":{}}'::jsonb NOT NULL,
	"account" text,
	"ms_tenant_id" text,
	"refresh_token" text,
	"connected_by" text,
	"connected_at" timestamp with time zone,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
