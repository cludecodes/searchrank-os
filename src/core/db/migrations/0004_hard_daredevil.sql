CREATE TABLE "conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_url" text,
	"landing_page" text,
	"keyword" text,
	"count" integer DEFAULT 1 NOT NULL,
	"revenue" real DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"qualified" boolean DEFAULT false NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_by" text
);
--> statement-breakpoint
CREATE TABLE "growth_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"problem" text NOT NULL,
	"search_demand" text,
	"buyer_intent" text,
	"competitor_weakness" text,
	"content_opportunity" text,
	"conversion_opportunity" text,
	"partnership" text,
	"referral" text,
	"score" integer DEFAULT 0 NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'identified' NOT NULL,
	"created_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_opportunities" ADD CONSTRAINT "growth_opportunities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversions_project_idx" ON "conversions" USING btree ("project_id","recorded_at");--> statement-breakpoint
CREATE INDEX "growth_opportunities_project_idx" ON "growth_opportunities" USING btree ("project_id","created_at");