DROP TABLE "config_masterdata_row" CASCADE;--> statement-breakpoint
DROP TABLE "entity_meta" CASCADE;--> statement-breakpoint
ALTER TABLE "config_masterdata" DROP COLUMN "synced_at";--> statement-breakpoint
ALTER TABLE "config_masterdata" DROP COLUMN "sync_error";--> statement-breakpoint
ALTER TABLE "config_masterdata" DROP COLUMN "row_count";--> statement-breakpoint
ALTER TABLE "sap_connection" DROP COLUMN "local_currency";--> statement-breakpoint
ALTER TABLE "sap_connection" DROP COLUMN "open_counts";--> statement-breakpoint
ALTER TABLE "assistant_report" DROP COLUMN "last_result";--> statement-breakpoint
ALTER TABLE "assistant_report" DROP COLUMN "last_run_at";