# Ticket Booking System

A full-stack ticket booking platform for movies and concerts featuring a visual seat map, time-limited seat holds with automatic TTL release, a FIFO waitlist with auto-assignment, and QR-code tickets delivered by email. Built with a single Node.js/Express backend, an embedded SQLite database, and a dependency-free vanilla JS frontend so the whole system runs on one process.

## Features

### Admin
- Manage venues, venue categories, and show/event setups
- Oversee all bookings, waitlists, and seat availability across events
- Approve organiser accounts and event listings

### Organiser
- Create and publish events (movies, concerts) with showtimes and venue mapping
- Configure seat categories (e.g. Gold, Silver, Balcony) with per-category pricing
- View sales, seat-utilisation reports, and live booking/waitlist counts

### Customer
- Browse events and pick a showtime
- Visual, clickable seat map with availability states (free / held / sold)
- Hold seats with a TTL (default 10 minutes) — auto-released if not confirmed
- Join a waitlist when a seat is taken and get auto-assigned when one frees up
- Receive a QR-coded e-ticket by email after confirming payment

## Tech Stack

| Layer     | Technology                                      |
| --------- | ----------------------------------------------- |
| Backend   | Node.js, Express                                |
| Database  | better-sqlite3 (embedded SQLite, ACID, fast)    |
| Frontend  | Vanilla JS / HTML / CSS (no framework)          |
| Email     | nodemailer (SMTP)                               |
| Tickets   | qrcode (QR code generation, sent as email)      |

## Setup Guide

```bash
git clone <repo-url> TicketBookingSystem
cd TicketBookingSystem
npm install
cp .env.example .env
npm run seed
npm start
```

Then open **http://localhost:3000** in your browser.

- Seed data and demo accounts are loaded by `npm run seed`.
- The server runs on the port in `PORT` (default `3000`).

## Seeded Demo Accounts

| Role      | Email                  | Password      |
| --------- | ---------------------- | ------------- |
| Admin     | admin@example.com      | admin123      |
| Organiser | organiser@example.com  | organiser123  |
| Customer  | customer@example.com   | customer123   |

## Environment Variables (`.env`)

| Variable          | Description                                                            | Default            |
| ----------------- | ---------------------------------------------------------------------- | ------------------ |
| `PORT`            | HTTP port the Express server listens on                                | `3000`             |
| `SECRET`          | Secret key used to sign JWT auth tokens                                | *(required)*       |
| `HOLD_TTL_MINUTES`| Minutes a held seat stays locked before auto-release                   | `10`               |
| `OFFER_TTL_MINUTES`| Minutes a waitlist offer (place-hold) stays valid before expiry       | `10`               |
| `APP_URL`         | Public base URL used in emails/links (e.g. `http://localhost:3000`)    | `http://localhost:3000` |
| `SMTP_HOST`       | SMTP server hostname for sending tickets (e.g. `smtp.gmail.com`)       | —                  |
| `SMTP_PORT`       | SMTP server port                                                       | `587`              |
| `SMTP_USER`       | SMTP username / email account                                          | —                  |
| `SMTP_PASS`       | SMTP password or app password                                          | —                  |
| `SMTP_FROM`       | "From" address shown on outgoing emails                                | —                  |

## API Reference

Auth: most endpoints require `Authorization: Bearer <JWT>`. Roles — `A` admin, `O` organiser, `C` customer.

### Auth
| Method | Path                | Auth | Description                              |
| ------ | ------------------- | ---- | ---------------------------------------- |
| POST   | `/api/auth/register`| –    | Register a customer account              |
| POST   | `/api/auth/login`   | –    | Login, returns JWT                       |

### Events & Catalog
| Method | Path                   | Auth | Description                        |
| ------ | ---------------------- | ---- | ---------------------------------- |
| GET    | `/api/events`          | –    | List published events              |
| GET    | `/api/events/:id`      | –    | Event details + showtimes          |
| GET    | `/api/shows/:id/seats` | C    | Seat map for a showtime            |

### Seats, Hold, Book, Cancel
| Method | Path                       | Auth | Description                                             |
| ------ | -------------------------- | ---- | ------------------------------------------------------- |
| POST   | `/api/shows/:id/hold`      | C    | Place a TTL hold on one or more seats                   |
| POST   | `/api/shows/:id/book`      | C    | Confirm hold & book seats (issues ticket, sends email)  |
| POST   | `/api/shows/:id/cancel`    | C    | Cancel a confirmed booking (frees seats)                |
| GET    | `/api/seats/:holdId`       | C    | Query the status/remaining TTL of a hold                |

### Waitlist
| Method | Path                        | Auth | Description                                    |
| ------ | --------------------------- | ---- | ---------------------------------------------- |
| POST   | `/api/shows/:id/waitlist`   | C    | Join waitlist for a category                    |
| GET    | `/api/waitlist/:entryId`    | C    | Check waitlist position & offer status          |
| POST   | `/api/offers/:offerId/accept`| C   | Accept a seat offer within offer TTL            |
| POST   | `/api/offers/:offerId/decline`| C  | Decline an offer (next-in-line gets it)         |

### Organiser
| Method | Path                     | Auth | Description                                  |
| ------ | ------------------------ | ---- | -------------------------------------------- |
| POST   | `/api/events`            | O    | Create an event                              |
| PUT    | `/api/events/:id`        | O    | Update event / publish                       |
| GET    | `/api/organiser/events`  | O    | List own events with sales/reports           |

### Admin
| Method | Path                     | Auth | Description                                  |
| ------ | ------------------------ | ---- | -------------------------------------------- |
| POST   | `/api/venues`            | A    | Create venue + categories                    |
| PUT    | `/api/venues/:id`        | A    | Update venue / category layout               |
| GET    | `/api/admin/users`       | A    | List users (approve/flag organiser accounts) |
| GET    | `/api/admin/bookings`    | A    | All bookings across events                   |

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

**Seat hold with TTL.** A customer selects seats and `POST /hold`. The server validates each seat is `free`, then marks them `held`, records a `hold_expires_at = now + HOLD_TTL_MINUTES`, and stores a `hold_id`. The client holds the seat for the TTL while the customer confirms payment. On expiry the hold is "lazy-expired" (checked on next access) and also reclaimed by a periodic sweep job that resets expired `held` seats back to `free`.

**Concurrency.** Holds are placed in a single transaction using `UPDATE ... WHERE status = 'free'` guarded statements so two customers can never hold the same seat. Seats are acquired atomically with `rowid` in `better-sqlite3` (serialized writes), and each acquisition re-checks the current status and expiry before committing — no double-bookings.

**Waitlist.** When a customer wants a category that is sold out, they join a FIFO queue (`waitlist` with a monotonic `position` per show+category). When a seat frees up (hold expiry, cancellation, or declined offer), the first waiting entry for that category is promoted to `offered`, given a unique `offer_token` and an `offer_expires_at = now + OFFER_TTL_MINUTES`, and the seat is placed on a short hold for them. If the offer is accepted (valid token, not expired), the seat is booked; otherwise the offer lapses and the next-in-line is offered the seat.

**Time-limited offers.** Offers are one-time tokens that can only be redeemed while valid and never expire beyond `OFFER_TTL_MINUTES`. Accept/decline endpoints validate the token, expiry, and seat status inside a transaction. Email notifications keep the customer informed of offer grants and expiry.

## Deployment

Works out of the box on any Node host (Render, Railway, Fly.io):

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Env:** set the variables from `.env.example` (especially `SECRET`, `APP_URL`, and SMTP settings) in the platform dashboard.
- **Database:** SQLite is a single file (`data/*.db`). Free-tier hosts do **not** persist disk across restarts — attach a persistent volume to `data/` so bookings survive redeploys. For production multi-instance scale, migrate to a shared Postgres.

**Hosted URL:** `https://<your-app>.onrender.com` (replace with your deployed app URL).

## Project Structure

```
TicketBookingSystem/
├── .env.example              # Environment variable template
├── .gitignore
├── package.json
├── server.js                 # Express entry point & API routes
├── seed.js                   # Seed script (demo accounts, venues, events)
├── docs/
│   └── system-design.md      # System design write-up
├── data/                     # SQLite database files (gitignored)
├── public/                   # Static frontend (vanilla JS/CSS)
│   ├── css/
│   └── js/
└── src/                      # Backend modules (db, auth, services)
```
