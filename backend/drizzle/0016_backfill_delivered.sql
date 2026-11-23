-- Custom SQL migration file, put your code below! --
-- Existing threads count as delivered up to now. Messages sent after this
-- migration start as "sent" and become "delivered" when the peer's socket
-- receives them.
UPDATE "conversations"
SET "low_delivered_at" = now(), "high_delivered_at" = now();