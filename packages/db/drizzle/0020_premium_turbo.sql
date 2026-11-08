ALTER TABLE "ai_usage" ADD COLUMN "skill" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "tools" text[] DEFAULT '{}'::text[] NOT NULL;