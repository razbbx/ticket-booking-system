# System Design Write-Up: Ticket Booking System

## Executive Summary & Architecture Overview
This document outlines the core technical architecture, data model, concurrency controls, seat hold TTL mechanisms, and automated waitlist reallocation flows for the **Ticket Booking System**. 

The system is deployed globally as a serverless edge service using **Cloudflare Workers** paired with **Cloudflare D1** (distributed SQLite database at the edge). This architecture delivers sub-50ms latency globally, serverless scalability, and strict ACID transactional integrity for high-concurrency event bookings.

---

## 1. Concurrency Protection & Race Condition Prevention
In high-demand ticketing scenarios (e.g., concert drops), thousands of concurrent requests attempt to reserve the same seat simultaneously. 

### Implementation Strategy
To prevent double-booking without introducing heavy global locking bottlenecks, concurrency protection is enforced at the database execution layer using **Atomic SQL Conditional Updates**:

```sql
UPDATE show_seats 
SET status = 'held', hold_token = ?, hold_expires_at = ?
WHERE event_id = ? 
  AND id IN (?, ?, ...)
  AND (status = 'available' OR (status = 'held' AND hold_expires_at < ?));
```

### Key Guarantees:
1. **Atomicity**: SQLite's single-writer WAL transaction engine ensures that if two requests execute concurrently, exactly one request will update the rows and return `affected_rows = N`.
2. **Conflict Detection**: If `affected_rows < requested_seats`, the transaction rolls back cleanly, throwing an `HTTP 409 Conflict: Seat already taken` error to the losing request.
3. **No Phantom Holds**: Read-modify-write race conditions are completely eliminated because row status checking and state mutation occur within a single atomic statement.

---

## 2. Seat Hold TTL & Automated Expiry Mechanism
When a customer selects seats, the system places a temporary **10-minute hold** (`HOLD_TTL_MINUTES = 10`) to allow checkout completion while preventing indefinite seat hoarding.

### Two-Tier Release Architecture
To guarantee that abandoned holds are released promptly even if the user closes their browser:

1. **Lazy Expiry on Query (Read Path)**:
   Any SQL read operation (fetching seat maps or attempting new holds) evaluates `effectiveStatus()`:
   ```javascript
   if (status === 'held' && hold_expires_at < Date.now()) {
     return 'available'; // Treated as available instantly
   }
   ```
2. **Eager Background Cleanup (Cron Worker)**:
   A scheduled Cloudflare Worker cron trigger runs every 1 minute (`*/1 * * * *`):
   ```sql
   UPDATE show_seats 
   SET status = 'available', hold_token = NULL, hold_expires_at = NULL
   WHERE status = 'held' AND hold_expires_at < ?;
   ```

---

## 3. Waitlist Queue & Automated Seat Reallocation Flow
When an event sells out, customers can join a category-specific waitlist. When an active booking is cancelled, the system automatically reallocates the freed seat to the next waitlisted customer.

```
[Booking Cancelled] 
       │
       ▼
[Atomic SQL Batch] ──► Release seat & set status = 'available'
       │
       ▼
[Waitlist Service] ──► Query oldest waitlist entry for event + category
       │
       ├─► Waitlist Entry Found?
       │        │
       │        ▼
       │   [Generate Cryptographic Claim Token] (10-min TTL)
       │        │
       │        ▼
       │   [Dispatch Notification Email] with time-limited link
       │        │
       │        ▼
       │   [Waitlisted Customer Claims Offer] ──► Converts to Booking
       │        │
       │        └─► Expired / Abandoned? ──► Offer next customer in line
       │
       └─► Waitlist Empty? ──► Seat remains available for public browsing
```

### Time-Limited Offer Link:
The waitlisted customer receives an email with a secure claim link (`#/event/ID?claim=TOKEN`). If the customer does not complete checkout before `OFFER_TTL_MINUTES` expires, the background cron trigger invalidates the offer and notifies the next customer in line.

---

## 4. QR Code Generation & Ticket Delivery
Upon confirmed booking completion:
1. An immutable booking reference (`TB-XXXXXXXX`) is generated.
2. A high-resolution **QR Code** encoding `TB-XXXXXXXX` is generated server-side as a Data URL.
3. The confirmation payload is stored in the database and dispatched asynchronously to the customer's email via the **Resend API**.

---

## 5. Summary of System Specs

| Component | Technical Choice / Specification |
|---|---|
| **Runtime Environment** | Cloudflare Workers (V8 Edge Runtime) |
| **Database** | Cloudflare D1 (Distributed SQLite at Edge) |
| **Authentication** | Stateless JWT (Bearer Tokens with role-based claims) |
| **Cron Scheduler** | Native Cloudflare Scheduled Triggers (`*/1 * * * *`) |
| **Seat Map UI** | BookMyShow No-Scroll Layout, 60fps 3D Zoom/Pan Engine |
