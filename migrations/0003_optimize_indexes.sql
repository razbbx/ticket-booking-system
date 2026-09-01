-- Optimize D1 rows_read: the per-minute cron sweep filtered on (status, *_expires_at)
-- without a usable index, forcing full table scans of show_seats and waitlist.
CREATE INDEX idx_show_seats_status_expiry ON show_seats(status, hold_expires_at);
CREATE INDEX idx_waitlist_status_expiry ON waitlist(status, offer_expires_at);
