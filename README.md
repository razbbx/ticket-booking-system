# Ticket Booking System

A full-stack ticket booking platform for movies and concerts featuring a visual seat map, time-limited seat holds that auto-release via TTL, a FIFO waitlist with automatic seat assignment, and QR-code tickets delivered by email.

The backend runs on **Cloudflare Workers** with **D1** (Cloudflare's serverless SQLite) for storage, and the frontend is a dependency-free vanilla JS/HTML/CSS single-page app. The previous Express + better-sqlite3 backend has been replaced by a Workers + D1 implementation: routes are Workers handlers, the SQLite database lives in D1, auth is done with Web Crypto (HMAC-signed tokens) instead of JWT, and emails go out via Cloudflare Email Sending (or Resend) instead of SMTP.

## Features

### Admin
- Manage venues, venue categories, and show/event setups
- Full CRUD for venues and categories (create, update, delete)
- Oversee bookings, waitlists, and seat availability across all events

### Organiser
- Create and publish events (movies, concerts) with showtimes and venue mapping
- Configure seat categories (e.g. Gold, Silver, Balcony) with per-category pricing
- List own events and view per-event sales revenue reports

### Customer
- Browse events and pick a showtime
- Visual, clickable seat map with availability states (free / held / sold)
- Hold seats with a TTL (default 10 minutes) — auto-released if not confirmed
- Join a waitlist when a seat is taken and get auto-assigned when one frees up
- Accept or decline time-limited seat offers (next-in-line promotion)
- Receive a QR-coded e-ticket by email after confirming booking

## Tech Stack

| Layer     | Technology                                              |
| --------- | ------------------------------------------------------- |
| Backend   | Cloudflare Workers (JavaScript)                         |
| Database  | D1 (Cloudflare's serverless SQLite, ACID)               |
| Frontend  | Vanilla JS / HTML / CSS (no framework)                  |
| Auth      | Web Crypto (HMAC-SHA256 signed tokens)                  |
| Tickets   | qrcode (QR code generation, embedded in email)          |
| Email     | Cloudflare Email Sending (primary) / Resend (optional)  |

> **Architecture change:** the app was migrated from a single Express + better-sqlite3 process to Cloudflare Workers + D1. Workers is stateless and edge-distributed; D1 persists all data and provides the serialised single-writer SQLite semantics that guarantee atomic seat mutations.

## Setup Guide

```bash
git clone <repo-url> TicketBookingSystem
cd TicketBookingSystem
npm install
npx wrangler login        # skip if already logged in
cp .dev.vars.example .dev.vars
# set SECRET to any random string, e.g.:
#   openssl rand -hex 32
npm run db:apply:local && npm run db:seed:local
npm run dev
```

Then open **http://localhost:8787** in your browser.

- `npm run db:apply:local` creates the D1 tables locally (from `migrations/`).
- `npm run db:seed:local` loads demo accounts, venues, and events.
- `npm run dev` starts the local Workers dev server on port `8787`.
- Until email is configured, ticket/offer emails are logged to the console (see `wrangler tail`).

## Seeded Demo Accounts

| Role      | Email                  | Password      |
| --------- | ---------------------- | ------------- |
| Admin     | admin@example.com      | admin123      |
| Organiser | organiser@example.com  | organiser123  |
| Customer  | customer@example.com   | customer123   |

## Deployment Guide

```bash
npx wrangler secret put SECRET     # same value as .dev.vars
npm run db:apply:remote && npm run db:seed:remote
npm run deploy                     # → https://<your-subdomain>.workers.dev
```

Then update the `APP_URL` var in `wrangler.jsonc` to your deployed URL (e.g. `https://ticket-booking-system.<your-subdomain>.workers.dev`) and redeploy with `npm run deploy`. `APP_URL` is used as the base URL in emails and links.

## Email Setup

Email sending is optional for local development — until configured, emails (QR tickets, waitlist offers) are written to the console.

**Primary — Cloudflare Email Sending:**

1. `npx wrangler email sending enable yourdomain.com` (once per zone/domain).
2. Add a send binding to `wrangler.jsonc`:
   ```json
   "send_email": [{ "name": "EMAIL" }]
   ```
3. Use a from address such as `anything@yourdomain.com`.

**Alternative — Resend:**

1. Create an API key at https://resend.com.
2. Set it as a secret: `npx wrangler secret put RESEND_API_KEY`.
3. Optionally override the sender with the `RESEND_FROM` var (defaults to `Ticket Booking <tickets@yourdomain.com>`).

## Configuration Reference

### `wrangler.jsonc` vars

| Var                | Description                                                             | Default            |
| ------------------ | ----------------------------------------------------------------------- | ------------------ |
| `APP_URL`          | Public base URL used in emails/links (deployed URL in production)       | `http://localhost:8787` |
| `HOLD_TTL_MINUTES` | Minutes a held seat stays locked before auto-release                    | `10`               |
| `OFFER_TTL_MINUTES`| Minutes a waitlist offer (place-hold) stays valid before expiry         | `10`               |

### `.dev.vars` (local only; mirror as secrets for production)

| Variable          | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `SECRET`          | Random string used to sign auth tokens (`openssl rand -hex 32`) |
| `RESEND_API_KEY`  | *(optional)* Resend API key (used only if set)          |
| `RESEND_FROM`     | *(optional)* Sender for Resend emails                   |

Production secrets are set with `npx wrangler secret put <NAME>` and are not committed to the repo.

## API Reference

Auth: most endpoints require `Authorization: Bearer <token>` (Web Crypto HMAC-signed). Roles — `A` admin, `O` organiser, `C` customer.

### Auth
| Method | Path                 | Auth | Description                    |
| ------ | -------------------- | ---- | ------------------------------ |
| POST   | `/api/auth/register` | –    | Register a customer account    |
| POST   | `/api/auth/login`    | –    | Login, returns signed token    |

### Events & Catalog
| Method | Path                 | Auth | Description             |
| ------ | -------------------- | ---- | ----------------------- |
| GET    | `/api/events`        | –    | List published events   |
| GET    | `/api/events/:id`    | –    | Event details + showtime|
| GET    | `/api/events/:id/seats` | – | Seat map for an event  |

### Seats, Hold, Book, Cancel
| Method | Path                        | Auth | Description                                        |
| ------ | --------------------------- | ---- | -------------------------------------------------- |
| POST   | `/api/events/:id/hold`      | C    | Place a TTL hold on one or more seats              |
| DELETE | `/api/events/:id/hold/:holdToken` | C | Release a hold early                            |
| POST   | `/api/events/:id/book`      | C    | Confirm hold & book seats (issues ticket, sends email) |
| POST   | `/api/events/:id/cancel`    | C    | Cancel a confirmed booking (frees seats)           |

### Waitlist
| Method | Path                         | Auth | Description                             |
| ------ | ---------------------------- | ---- | --------------------------------------- |
| POST   | `/api/events/:id/waitlist`   | C    | Join waitlist for a category             |
| POST   | `/api/waitlist/offer/:token` | C    | Accept a seat offer within offer TTL     |

### Bookings
| Method | Path               | Auth | Description                    |
| ------ | ------------------ | ---- | ------------------------------ |
| GET    | `/api/bookings`    | C    | List own bookings              |
| GET    | `/api/bookings/:ref`| C   | Booking detail + ticket info   |

### Organiser
| Method | Path                                  | Auth | Description                        |
| ------ | ------------------------------------- | ---- | ---------------------------------- |
| POST   | `/api/organiser/events`               | O    | Create an event                    |
| GET    | `/api/organiser/events`               | O    | List own events with reports       |
| GET    | `/api/organiser/events/:id/revenue`   | O    | Revenue report for one event       |

### Admin (venues CRUD) & Public (venues list)
| Method | Path                | Auth | Description                        |
| ------ | ------------------- | ---- | ---------------------------------- |
| GET    | `/api/venues`       | –    | List venues (public)               |
| POST   | `/api/venues`       | A    | Create venue + categories           |
| PUT    | `/api/venues/:id`   | A    | Update venue / category layout      |
| DELETE | `/api/venues/:id`   | A    | Delete venue                        |

## Database Schema

Tables: `users`, `venues`, `venue_categories`, `events`, `event_pricing`, `show_seats`, `bookings`, `waitlist`.

| Table             | Columns                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `users`           | `id`, `name`, `email` (unique), `password_hash`, `role` (`admin`/`organiser`/`customer`), `created_at` |
| `venues`          | `id`, `name`, `address`, `created_at`                                                     |
| `venue_categories`| `id`, `venue_id`, `name` (e.g. Gold), `rows`, `cols`, `base_price`                        |
| `events`          | `id`, `title`, `type` (movie/concert), `venue_id`, `showtime`, `status` (`draft`/`published`), `organiser_id`, `created_at` |
| `event_pricing`   | `id`, `event_id`, `category_id`, `price`                                                  |
| `show_seats`      | `id`, `show_id`, `row`, `col`, `category_id`, `status` (`free`/`held`/`booked`), `hold_id`, `hold_expires_at`, `booking_id` |
| `bookings`        | `id`, `booking_ref`, `user_id`, `show_id`, `status`, `total`, `ticket_json`, `created_at` |
| `waitlist`        | `id`, `show_id`, `user_id`, `category_id`, `position`, `offer_token`, `offer_expires_at`, `status` (`waiting`/`offered`/`assigned`/`expired`) |

## Seat Hold & Waitlist Logic

**Seat hold with TTL.** A customer selects seats and `POST /hold`. The server validates each seat is `free`, then marks them `held`, records a `hold_expires_at = now + HOLD_TTL_MINUTES` (configurable var, default 10 minutes), and stores a `hold_id`. The client holds the seats for the TTL while the customer confirms payment. On expiry the hold is "lazy-expired" (checked and reset on next access) and also reclaimed by a periodic cron sweep that resets expired `held` seats back to `free`.

**Concurrency prevention.** Holds and bookings are executed as a single guarded `UPDATE ... WHERE status = 'free'` (or `... WHERE status='held' AND hold_expires_at > now` for booking). This atomic compare-and-set runs in one statement, and D1 serialises writes on the SQLite single-writer lock, so two customers can never hold the same seat and a hold can never be double-booked. Batch seat operations run inside a D1 transaction (`batch`), so a multi-seat hold either commits fully or not at all.

**Waitlist auto-assignment.** When a customer wants a category that is sold out, they join a FIFO queue (`waitlist` with a monotonic `position` per show+category). When a seat frees up (hold expiry, cancellation, or declined offer), the first `waiting` entry for that category is promoted to `offered` — given a unique `offer_token` and an `offer_expires_at = now + OFFER_TTL_MINUTES` — and the seat is placed on a short hold bound to that token. If the offer is accepted (valid token, not expired), the seat is booked; otherwise it lapses and the next-in-line is promoted.

**Time-limited offers.** Offers are one-time tokens that can only be redeemed while valid and never outlive `OFFER_TTL_MINUTES`. The accept endpoint validates the token, expiry, and seat status inside a transaction, so a token can only ever be redeemed once — preventing double-claims and stale redemptions. Email notifications keep the customer informed of offer grants and expiry.

## Hosted URL

Hosted at: `https://ticket-booking-system.fshare-ayush-demo.workers.dev`

## Project Structure

```
TicketBookingSystem/
├── .dev.vars.example         # Local secrets template (SECRET, Resend)
├── .gitignore
├── package.json
├── wrangler.jsonc            # Workers config (bindings, D1, vars, send_email)
├── migrations/               # D1 SQL migrations (applied via db:apply:local/remote)
├── docs/
│   └── system-design.md      # System design write-up
├── public/                   # Static frontend (vanilla JS/CSS)
│   ├── index.html
│   ├── css/
│   └── js/
└── src/                      # Workers modules
    ├── index.js              # Entry point & request router
    ├── auth.js               # Web Crypto auth (tokens, roles)
    ├── db.js                 # D1 queries + prepared statements
    ├── routes/               # Route handlers (auth, events, seats, bookings, waitlist, organiser, admin)
    └── services/             # Business logic (holds, waitlist, email, qr)
```
