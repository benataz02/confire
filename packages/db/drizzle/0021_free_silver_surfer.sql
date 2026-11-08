-- The SAP step folds into the one status: a project SAP took past "Quoted" carries that step as its
-- status. journeyOf already let the step outrank the status, so nothing a page shows moves.
UPDATE "config_project" SET "status" = "sap_step" WHERE "sap_step" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "config_project" DROP COLUMN "sap_step";
