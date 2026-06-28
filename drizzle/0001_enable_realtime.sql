-- Enable Supabase Realtime for messages and channels
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)

-- Add tables to the realtime publication (required for postgres_changes subscriptions)
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE channels;
