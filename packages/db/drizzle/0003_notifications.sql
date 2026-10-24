CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"params" jsonb NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_optout" (
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"type" text NOT NULL,
	"channel" text NOT NULL,
	CONSTRAINT "notification_optout_user_id_tenant_id_type_channel_pk" PRIMARY KEY("user_id","tenant_id","type","channel")
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_optout" ADD CONSTRAINT "notification_optout_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("user_id","tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "portal_company" DROP COLUMN "notify";--> statement-breakpoint
-- The D27/D22 settings are each user's own now (notifications spec §11); no carry-over.
UPDATE "portal_settings" SET "settings" = "settings" - 'notify' - 'notifyFallback';
