-- Add last_fired_at column to alert_rules for durable cooldown tracking.
-- Prevents alert spam across server cold starts.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS last_fired_at timestamptz;
