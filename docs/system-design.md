# System Design — Ticket Booking System

A single-process Node.js/Express application backed by `better-sqlite3` (embedded SQLite). SQLite serialises writes, giving us a single writer lock that makes every seat mutation effectively serialised without external infrastructure. This design note covers seat holds with TTL, concurrency prevention, the waitlist auto-assignment flow, and time-limited offers.

## 1. Seat Hold with TTL

When a customer chooses seats on the seat map, the client calls `POST /shows/:id/hold` with the selected seat coordinates. The server:

1. Loads each `show_seats` row for the show and validates that its `status` is `free`.
2. In one transaction, flips matching rows to `status = 'held'`, records `hold_id`, and sets `hold_expires_at = now + HOLD_TTL_MINUTES` (default 10).
3. Returns the `hold_id` and its deadline to the client.

The hold gives the customer exclusive reservation time to confirm payment. Because `better-sqlite3` is synchronous and SQLite serialises writers, the check-and-update of step 1–2 happens with no interleaving from other requests, which is the core of the concurrency guarantee (see §2).

Expiry is handled two ways:

- **Lazy expiry:** any read of a held seat (e.g. rendering the seat map or attempting a hold on it) first checks `hold_expires_at`; stale `held` rows are reset to `free` on sight.
- **Sweep:** a periodic job scans `show_seats`, finds rows where `status = 'held'` and `hold_expires_at < now`, and resets them to `free` (also releasing the matching waitlist offers, §3).

Both paths run as transactions so a seat can never be freed and re-acquired in a torn state.

## 2. Concurrency Prevention

The danger scenarios are (a) two customers holding the same seat, and (b) a hold expiring while a booking is being written. Three layers prevent this:

1. **Serialised transactions.** `better-sqlite3` runs synchronously on one thread; each hold/booking/cancel is wrapped in `db.transaction()`. Since SQLite allows a single writer at a time, two concurrent holds on the same seat queue and execute one after the other.
2. **Conditional update.** A seat is only claimed with a guarded statement, e.g. `UPDATE show_seats SET status='held', hold_id=?, hold_expires_at=? WHERE id=? AND status='free'` plus `changes() > 0` check. The second customer's update affects 0 rows and is rejected with a conflict response. Booking uses the same pattern: `... WHERE id=? AND status='held' AND hold_expires_at > now`.
3. **Idempotency tokens.** Holds carry a unique `hold_id`; bookings reference a `hold_id` and expire with it, so a repeated or stale request cannot double-book or book an expired hold.

Seat maps are also served from a single indexed read (`show_id`, `row`, `col`), so the UI always reflects the latest committed state.

## 3. Waitlist Auto-Assignment Flow

When a requested category is sold out, the customer may `POST /shows/:id/waitlist` to join a FIFO queue:

1. A row is inserted into `waitlist` with `status = 'waiting'` and a `position` derived per `(show_id, category_id)`, guaranteeing insertion order (older entries get lower positions).
2. When a seat frees up — via the sweep expiring a hold, a booking cancellation, or a declined offer — the server finds the lowest-position `waiting` entry for that category and promotes it:
   - a unique, unguessable `offer_token` is generated and stored,
   - `offer_expires_at = now + OFFER_TTL_MINUTES` is set,
   - `status` becomes `offered`,
   - the freed seat is placed on a short hold bound to that token, and the user is emailed a "seat available" notification with a claim link.
3. The user claims within the TTL (see §4). If they fail to, the offer expires and the seat passes to the next `waiting` entry, continuing down the queue.

All assignment steps run inside the same transaction that freed the seat, so a seat is never simultaneously free and offered.

## 4. Time-Limited Offer Handling

Offers are single-use tokens that enforce both authenticity and freshness:

- **Redeem path:** `POST /offers/:offerId/accept` validates (a) the `offer_token` matches, (b) `offer_expires_at > now`, (c) `status = 'offered'`, and (d) the bound seat is still `held`. If all pass, the seat is booked, the waitlist entry moves to `assigned`, a QR-coded ticket is emailed, and the token is invalidated so it cannot be replayed.
- **Reject path:** `POST /offers/:offerId/decline` marks the entry `assigned` (declined), frees the seat, and triggers assignment to the next-in-line.
- **Expiry:** lazy checks plus the sweep flip any `offered` entry past its deadline back to `waiting` (or drop it), releasing the seat and re-triggering §3 for the next customer.

Because accept/decline re-check status and expiry inside a transaction, a token can only ever be redeemed once, and only while valid — preventing double-claims and stale redemptions.

## Summary

Holds give customers a bounded reservation window; synchronous serialised transactions with guarded updates prevent double-booking; a FIFO waitlist with token-based offers reassigns freed seats automatically; and TTLs on both holds and offers keep the system fair, deterministic, and free of leaked capacity.
