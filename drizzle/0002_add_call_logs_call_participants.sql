CREATE TABLE IF NOT EXISTS "reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"emoji" varchar(8) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"caller_id" uuid,
	"callee_id" uuid,
	"room_name" varchar(128),
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"duration" integer,
	"status" text NOT NULL,
	"channel_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_log_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"username" varchar(32) NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp,
	"duration" integer
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reactions" ADD CONSTRAINT "reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_caller_id_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_callee_id_users_id_fk" FOREIGN KEY ("callee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_call_log_id_call_logs_id_fk" FOREIGN KEY ("call_log_id") REFERENCES "public"."call_logs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_reactions_message_user_emoji" ON "reactions" USING btree ("message_id","user_id","emoji");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reactions_message" ON "reactions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_call_logs_caller" ON "call_logs" USING btree ("caller_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_call_logs_callee" ON "call_logs" USING btree ("callee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_call_logs_started" ON "call_logs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cp_call_user" ON "call_participants" USING btree ("call_log_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cp_user" ON "call_participants" USING btree ("user_id");
