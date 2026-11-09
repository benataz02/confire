CREATE TABLE "sap_cache" (
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"company" text,
	"data" jsonb,
	"error" text,
	"fetched_at" timestamp with time zone,
	CONSTRAINT "sap_cache_tenant_id_kind_key_seq_pk" PRIMARY KEY("tenant_id","kind","key","seq")
);
