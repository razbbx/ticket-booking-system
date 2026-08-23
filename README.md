# 🎟️ Ticket Booking System — High-Demand Event Platform

[![Live Application](https://img.shields.io/badge/Live_Demo-Cloudflare_Workers-f38020?style=for-the-badge&logo=cloudflare)](https://ticket-booking-system.fshare-ayush-demo.workers.dev)
[![GitHub Repository](https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github)](https://github.com/razbbx/ticket-booking-system)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

A production-grade, full-stack **Movie & Concert Ticket Booking Platform** built for high-demand events. Features an interactive **BookMyShow-style visual seat map**, concurrency-protected seat holds with configurable TTL, automated waitlist seat reallocation on cancellations, and instant QR code ticket delivery via email.

---

## 🌐 Live Application & Deployment Links

- **Live Production URL**: [https://ticket-booking-system.fshare-ayush-demo.workers.dev](https://ticket-booking-system.fshare-ayush-demo.workers.dev)
- **GitHub Repository (`main` branch)**: [https://github.com/razbbx/ticket-booking-system](https://github.com/razbbx/ticket-booking-system)

---

## 🌟 Key Features & Highlights

### 🎭 Visual Seat Map & UI Excellence
- **BookMyShow Viewport Architecture**: Fixed 100vh no-scroll application shell with pinned header and sleek 50px bottom checkout toolbar.
- **60FPS 3D Zoom & Drag-Pan Engine**: Hardware-accelerated smooth canvas zooming with auto-fit screen calculation for large venues (up to 2,400 seats).
- **Realistic Aisle & Section Layouts**: Movies feature `25% : 50% : 25%` horizontal aisle gaps and `20% : 60% : 20%` vertical walkways.
- **Real-Time Seat Status**: Color-coded seat states (Available, Selected, Held by You, Booked).

### 🔒 Concurrency Control & Seat Hold TTL
- **Atomic SQL Concurrency Protection**: Multi-user race condition protection using conditional atomic database updates (`UPDATE ... WHERE status = 'available'`). Prevents double-booking under extreme load.
- **Configurable Hold TTL (10 Mins)**: Selected seats are placed on a 10-minute hold. If checkout is abandoned, seats auto-release.
- **Background Cron Release Worker**: Cloudflare Scheduled Worker (`*/1 * * * *`) automatically purges expired seat holds and waitlist offers every 60 seconds.

### 📋 Waitlist Management & Auto-Reallocation
- **Category-Based Waitlists**: Customers can join waitlists per seat category (Premium, Standard) when an event sells out.
- **Automatic Cancellation Reallocation**: Cancelling a booking triggers an automated waitlist search, generating a cryptographic time-limited claim token (`#/event/ID?claim=TOKEN`) emailed to the next customer in line.

### 🎫 QR Code Tickets & Email Notifications
- **Server-Side QR Generation**: Generates high-resolution QR code encoding the unique booking reference (`TB-XXXXXXXX`).
- **Instant Email Delivery**: Dispatches confirmation emails with QR tickets via Resend API integration.

---

## 👥 Role-Based Access & Demo Credentials

| Role | Email | Password | Permissions |
|---|---|---|---|
| **Admin** | `admin@example.com` | `admin123` | Create venues, define rows/cols & seat categories |
| **Organiser** | `organiser@example.com` | `organiser123` | Create listings, set per-category pricing, view revenue reports |
| **Customer** | `customer@example.com` | `customer123` | Browse events, hold/book seats, join waitlists, view history & cancel |

---

## 🛠️ Technology Stack

- **Runtime & Hosting**: [Cloudflare Workers](https://workers.cloudflare.com/) (Edge V8 JavaScript Runtime)
- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/) (Distributed SQLite at the Edge)
- **Frontend**: Vanilla JavaScript (ES6+), HTML5, CSS3 Glassmorphism System
- **Email & QR**: Resend API & QR Code Generator
- **Authentication**: Stateless JWT (JSON Web Tokens) with role claims

---

## ⚡ Quick Start & Local Setup Guide

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher)
- Cloudflare Wrangler CLI (`npm install -g wrangler`)

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/razbbx/ticket-booking-system.git
cd TicketBookingSystem

# Install dependencies
npm install
```

### 3. Environment Variables Setup
Copy `.env.example` to `.dev.vars` for local development:
```bash
cp .env.example .dev.vars
```

### 4. Local Database Setup & Migrations
```bash
# Apply database migrations to local D1 SQLite engine
npx wrangler d1 execute ticket-booking-db --local --file=./migrations/0001_init.sql
npx wrangler d1 execute ticket-booking-db --local --file=./migrations/0002_seed.sql
npx wrangler d1 execute ticket-booking-db --local --file=./migrations/0003_populate_events.sql
npx wrangler d1 execute ticket-booking-db --local --file=./migrations/0004_expanded_venues.sql
```

### 5. Run Local Development Server
```bash
# Start local dev server connected to remote D1 or local SQLite
npx wrangler dev --remote --port 8787
```
Open **[http://localhost:8787](http://localhost:8787)** in your browser.

---

## 📡 API Endpoints Reference Table

All API endpoints are prefixed with `/svc/` to avoid browser ad-blocker filter conflicts.

### Authentication (`/svc/auth`)
| Method | Endpoint | Access | Description |
|---|---|---|---|
| `POST` | `/svc/auth/register` | Public | Register new user (Customer or Organiser) |
| `POST` | `/svc/auth/login` | Public | Authenticate user and return JWT bearer token |
| `GET` | `/svc/auth/me` | Authenticated | Retrieve current user profile |

### Events & Seat Selection (`/svc/events`)
| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/svc/events` | Public | List all upcoming events (supports `?q=`, `?type=`) |
| `GET` | `/svc/events/:id` | Public | Get single event details and category pricing |
| `GET` | `/svc/events/:id/seats` | Public | Get real-time seat status grid for event venue |
| `POST` | `/svc/events/:id/hold` | Customer | Hold selected seats for 10 minutes |
| `DELETE` | `/svc/events/:id/hold/:token` | Customer | Manually release held seats |
| `POST` | `/svc/events/:id/book` | Customer | Complete booking for held seats & generate QR |

### Bookings & History (`/svc/bookings`)
| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/svc/bookings` | Customer | View customer booking history & QR tickets |
| `POST` | `/svc/events/:id/cancel` | Customer | Cancel booking & trigger waitlist reallocation |

### Organiser & Admin (`/svc/organiser`, `/svc/admin`)
| Method | Endpoint | Access | Description |
|---|---|---|---|
| `POST` | `/svc/organiser/events` | Organiser | Create new movie or concert listing |
| `GET` | `/svc/organiser/events/:id/revenue` | Organiser | View per-category booking revenue report |
| `POST` | `/svc/admin/venues` | Admin | Create new venue with row/col seat layout |

---

## 🗄️ Database Schema & Architecture

The database schema is defined in [`migrations/0001_init.sql`](file:///home/raz/Documents/projects/Unthinkable/TicketBookingSystem/migrations/0001_init.sql):

- **`users`**: Stores user accounts, hashed passwords, roles (`admin`, `organiser`, `customer`).
- **`venues`**: Defines venue physical layouts (`rows`, `cols`, `address`).
- **`events`**: Links listings to venue, date, time, and organiser.
- **`event_pricing`**: Stores per-category pricing for each event.
- **`show_seats`**: Real-time seat inventory per show (`seat_row`, `seat_col`, `status`, `hold_token`, `hold_expires_at`).
- **`bookings`**: Stores confirmed bookings, unique reference `TB-XXXXXXXX`, and QR data.
- **`waitlist`**: Stores category waitlist queues and claim offer tokens.

---

## 📝 System Design Summary (Max 800 Words)

For the full detailed System Design Document, see [`SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md).

### Concurrency & Concurrency Control
Concurrency protection is achieved at the database engine level using **atomic conditional updates**:
```sql
UPDATE show_seats SET status = 'held', hold_token = ? 
WHERE event_id = ? AND id IN (...) 
  AND (status = 'available' OR (status = 'held' AND hold_expires_at < ?));
```
If two users select the same seat simultaneously, exactly one statement updates the database row. The losing request receives an `HTTP 409 Conflict` response and is prompted to choose another seat.

### Waitlist Auto-Reallocation
When a booking is cancelled, the system executes an atomic batch transaction freeing the seat and querying the oldest waitlist entry for that category. A secure 10-minute claim token is generated and emailed to the waitlisted customer. If unclaimed before expiration, the Cloudflare Cron Worker offers the seat to the next person in line.

---

## 📄 License
This project is licensed under the MIT License - see the `LICENSE` file for details.
