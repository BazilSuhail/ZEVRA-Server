ALTER TABLE "reactions" ALTER COLUMN "emoji" SET DATA TYPE varchar(32);--> statement-breakpoint
DROP INDEX IF EXISTS "idx_sender_keys_group_receiver_epoch";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sender_keys_group_owner_receiver_epoch" ON "sender_keys" USING btree ("group_id","owner_id","receiver_id","epoch");--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "token_hash" varchar(64);--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name = 'token'
	) THEN
		UPDATE "refresh_tokens"
		SET "token_hash" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
		WHERE "token_hash" IS NULL;
	END IF;
END $$;
--> statement-breakpoint
DELETE FROM "refresh_tokens" WHERE "token_hash" IS NULL OR "expires_at" < now();--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "token_hash" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_token_unique";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "token";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_user" ON "refresh_tokens" USING btree ("user_id");
