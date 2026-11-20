CREATE TABLE IF NOT EXISTS "code_pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"branch" text,
	"base_branch" text,
	"pr_number" integer,
	"pr_url" text,
	"head_sha" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preview_url" text,
	"before_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"change_approval_id" uuid,
	"merge_approval_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_at" timestamp with time zone,
	"reverted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_pipelines_workspace_idx" ON "code_pipelines" USING btree ("workspace_id","created_at");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "code_pipelines" ADD CONSTRAINT "code_pipelines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "code_pipelines" ADD CONSTRAINT "code_pipelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "code_pipelines" ADD CONSTRAINT "code_pipelines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
