CREATE TABLE "assistant_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"definition" jsonb,
	"saved" boolean DEFAULT false NOT NULL,
	"last_result" jsonb,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_thread" ADD COLUMN "report_id" uuid;--> statement-breakpoint
CREATE INDEX "assistant_report_user_idx" ON "assistant_report" USING btree ("tenant_id","user_id","updated_at");--> statement-breakpoint
ALTER TABLE "assistant_thread" ADD CONSTRAINT "assistant_thread_report_id_assistant_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."assistant_report"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_thread_report_uq" ON "assistant_thread" USING btree ("tenant_id","user_id","report_id") WHERE "assistant_thread"."report_id" is not null;