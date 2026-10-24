ALTER TABLE "config_project" ADD COLUMN "b1_company" text;--> statement-breakpoint
ALTER TABLE "sap_connection" ADD COLUMN "tunnel_id" text;--> statement-breakpoint
ALTER TABLE "sap_connection" ADD COLUMN "company_db" text;--> statement-breakpoint
ALTER TABLE "sap_connection" DROP COLUMN "access_client_id";--> statement-breakpoint
ALTER TABLE "sap_connection" DROP COLUMN "access_client_secret";--> statement-breakpoint
ALTER TABLE "sap_connection" DROP COLUMN "beas_enabled";