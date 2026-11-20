CREATE TABLE "seo_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"audit_id" uuid,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"framework" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"rationale" text,
	"created_by_agent" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seo_artifacts" ADD CONSTRAINT "seo_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_artifacts" ADD CONSTRAINT "seo_artifacts_audit_id_seo_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."seo_audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_artifacts" ADD CONSTRAINT "seo_artifacts_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seo_artifacts_project_kind_path_unique" ON "seo_artifacts" USING btree ("project_id","kind","path");