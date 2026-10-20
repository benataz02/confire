CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL,
	"card_code" text,
	"register_domain" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL,
	"card_code" text
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ui_user_state" (
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ui_user_state_tenant_id_user_id_key_pk" PRIMARY KEY("tenant_id","user_id","key")
);
--> statement-breakpoint
CREATE TABLE "ui_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"table_id" text NOT NULL,
	"name" text NOT NULL,
	"visibility" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_masterdata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'table' NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"query" jsonb,
	"synced_at" timestamp with time zone,
	"sync_error" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_masterdata_row" (
	"tenant_id" text NOT NULL,
	"masterdata_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"row" jsonb NOT NULL,
	CONSTRAINT "config_masterdata_row_tenant_id_masterdata_id_seq_pk" PRIMARY KEY("tenant_id","masterdata_id","seq")
);
--> statement-breakpoint
CREATE TABLE "config_model" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"portal" boolean DEFAULT false NOT NULL,
	"portal_pricing" text DEFAULT 'request' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"model_id" uuid NOT NULL,
	"name" text NOT NULL,
	"customer" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"portal_card_code" text,
	"assignee_id" text,
	"quote_response" text,
	"quote_responded_at" timestamp with time zone,
	"entries" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"batches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selection" jsonb,
	"calculated_at" timestamp with time zone,
	"b1_doc_entry" integer,
	"quoted_at" timestamp with time zone,
	"quoted_value" numeric(18, 4),
	"quoted_cost" numeric(18, 4),
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_project_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" text,
	"actor_side" text NOT NULL,
	"visibility" text DEFAULT 'external' NOT NULL,
	"note" text,
	"payload" jsonb,
	"mail_error" text
);
--> statement-breakpoint
CREATE TABLE "project_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" uuid,
	"event_id" uuid,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" text,
	"visibility" text DEFAULT 'external' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_snapshot" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "entity_meta" (
	"tenant_id" text NOT NULL,
	"entity_name" text NOT NULL,
	"json" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_meta_tenant_id_entity_name_pk" PRIMARY KEY("tenant_id","entity_name")
);
--> statement-breakpoint
CREATE TABLE "sap_connection" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"agent_url" text NOT NULL,
	"secret" text NOT NULL,
	"access_client_id" text,
	"access_client_secret" text,
	"beas_enabled" boolean DEFAULT false NOT NULL,
	"local_currency" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "portal_company" (
	"tenant_id" text NOT NULL,
	"card_code" text NOT NULL,
	"card_name" text NOT NULL,
	"card_type" text NOT NULL,
	"notify" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_company_tenant_id_card_code_pk" PRIMARY KEY("tenant_id","card_code")
);
--> statement-breakpoint
CREATE TABLE "portal_company_domain" (
	"tenant_id" text NOT NULL,
	"domain" text NOT NULL,
	"card_code" text NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_company_domain_tenant_id_domain_pk" PRIMARY KEY("tenant_id","domain")
);
--> statement-breakpoint
CREATE TABLE "portal_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_project_event" ADD CONSTRAINT "config_project_event_project_id_config_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."config_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file" ADD CONSTRAINT "project_file_project_id_config_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."config_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file" ADD CONSTRAINT "project_file_event_id_config_project_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."config_project_event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_company_domain" ADD CONSTRAINT "portal_company_domain_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_company_domain" ADD CONSTRAINT "portal_company_domain_company_fk" FOREIGN KEY ("tenant_id","card_code") REFERENCES "public"."portal_company"("tenant_id","card_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "ui_view_lookup_idx" ON "ui_view" USING btree ("tenant_id","table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_masterdata_tenant_name_uq" ON "config_masterdata" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "config_model_tenant_idx" ON "config_model" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "config_project_tenant_status_idx" ON "config_project" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "config_project_portal_company_idx" ON "config_project" USING btree ("tenant_id","portal_card_code");--> statement-breakpoint
CREATE INDEX "config_project_event_project_idx" ON "config_project_event" USING btree ("project_id","at");--> statement-breakpoint
CREATE INDEX "project_file_project_idx" ON "project_file" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "portal_company_domain_company_idx" ON "portal_company_domain" USING btree ("tenant_id","card_code");