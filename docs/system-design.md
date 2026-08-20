# System Design — Ticket Booking System

A Cloudflare Workers application backed by D1, Cloudflare's serverless SQLite. Workers is stateless and edge-distributed; D1 persists all data and serialises writes through SQLite's single-writer lock, so every seat mutation is effectively serialised without external infrastructure. This design note covers seat holds with TTL, concurrency prevention, waitlist auto-assignment, and time-limited offers.

## 1. Seat Hold with TTL

When a customer chooses seats on the seat map, the client calls `POST /events/:id/hold` with the selected seat coordinates. The handler:

1. Validates each `show_seats` row for the show is `status = 'free'`.
2. In one atomic statement, flips matching rows to `status = 'held'`, records `hold_id`, and sets `hold_expires_at = now + HOLD_TTL_MINUTES` (configurable var, default 10).
3. Returns the `hold_id` and its deadline to the client.

The hold gives the customer exclusive reservation time to confirm payment. Because D1 serialises writers, the check-and-update of steps 1–2 happens with no interleaving from other requests (see §2).

Expiry is handled two ways:

- **Lazy expiry:** any read of a held seat (rendering the seat map, attempting a hold) first checks `hold_expires_at`; stale `held` rows are reset to `free` on sight.
- **Sweep:** a scheduled cron handler scans `show_seats` for `status = 'held' AND hold_expires_at < now` and resets them to `free`, also releasing matching waitlist offers (§3).

Both paths run as transactions so a seat can never be freed and re-acquired in a torn state.

## 2. Concurrency Prevention

The danger scenarios are (a) two customers holding the same seat and (b) a hold expiring mid-booking. Three layers prevent this:

1. **Serialised writes.** D1 is SQLite under the hood: a single writer at a time, so concurrent holds on the same seat queue and execute one after the other.
2. **Single-statement guarded UPDATE (CAS).** A seat is only claimed with a guarded statement, e.g. `UPDATE show_seats SET status='held', hold_id=?, hold_expires_at=? WHERE id=? AND status='free'` plus a `meta.changes > 0` check. The second customer's update affects 0 rows and is rejected with a conflict response. Booking uses the same pattern: `... WHERE id=? AND status='held' AND hold_expires_at > now`. Because the CAS is a single statement, no separate read-then-write window exists.
3. **Batch transactions.** Multi-seat holds and booking transactions are grouped with `DB.batch()`, which executes the statements as one atomic transaction — all-or-nothing.

Seat maps are served from a single indexed read (`show_id`, `row`, `col`), so the UI always reflects the latest committed state.

## 3. Waitlist Auto-Assignment Flow

When a requested category is sold out, the customer may `POST /events/:id/waitlist` to join a FIFO queue:

1. A row is inserted into `waitlist` with `status = 'waiting'` and a `position` derived per `(show_id, category_id)`, guaranteeing insertion order.
2. When a seat frees up — the sweep expiring a hold, a booking cancellation, or a declined offer — the handler finds the lowest-position `waiting` entry for that category and promotes it:
   - a unique, unguessable `offer_token` is generated and stored,
   - `offer_expires_at = now + OFFER_TTL_MINUTES` is set,
   - `status` becomes `offered`,
   - the freed seat is placed on a short hold bound to that token, and the user is emailed a "seat available" notification with a claim link.
3. The user claims within the TTL (§4). If they do not, the offer expires and the seat passes to the next `waiting` entry, continuing down the queue.

All assignment steps run inside the same transaction that freed the seat, so a seat is never simultaneously free and offered.

## 4. Time-Limited Offer Handling

Offers are single-use tokens that enforce both authenticity and freshness:

- **Redeem path:** `POST /waitlist/offer/:token` validates (a) the `offer_token` matches, (b) `offer_expires_at > now`, (c) `status = 'offered'`, and (d) the bound seat is still `held`. If all pass, the seat is booked, the waitlist entry moves to `assigned`, a QR-coded ticket is emailed, and the token is invalidated so it cannot be replayed.
- **Reject path:** declining (or letting the offer expire) frees the seat and triggers assignment to the next-in-line.
- **Expiry:** lazy checks plus the sweep flip any `offered` entry past its deadline back to `waiting` (or drop it), releasing the seat and re-triggering §3.

Because redeem re-checks status and expiry inside a transaction, a token can only ever be redeemed once, and only while valid — preventing double-claims and stale redemptions.

## Summary

Holds give customers a bounded reservation window; D1's serialised writes with single-statement guarded updates prevent double-holding and double-booking; a FIFO waitlist with token-based offers reassigns freed seats automatically; and TTLs on both holds and offers keep the system fair, deterministic, and free of leaked capacity.
