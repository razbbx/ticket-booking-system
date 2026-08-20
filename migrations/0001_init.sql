CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('customer', 'organiser', 'admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE venues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  address    TEXT,
  rows       INTEGER NOT NULL,
  cols       INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE venue_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id      INTEGER NOT NULL REFERENCES venues(id),
  category_name TEXT NOT NULL,
  row_count     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  organiser_id INTEGER NOT NULL REFERENCES users(id),
  venue_id     INTEGER NOT NULL REFERENCES venues(id),
  title        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('movie', 'concert')),
  date         TEXT NOT NULL,
  time         TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE event_pricing (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id),
  category_name TEXT NOT NULL,
  price         REAL NOT NULL
);

CREATE TABLE show_seats (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       INTEGER NOT NULL REFERENCES events(id),
  seat_row       INTEGER NOT NULL,
  seat_col       INTEGER NOT NULL,
  category_name  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
  hold_token     TEXT,
  hold_expires_at INTEGER,
  UNIQUE (event_id, seat_row, seat_col)
);

CREATE TABLE bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_ref  TEXT NOT NULL UNIQUE,
  event_id     INTEGER NOT NULL REFERENCES events(id),
  customer_id  INTEGER NOT NULL REFERENCES users(id),
  seat_id      INTEGER NOT NULL REFERENCES show_seats(id),
  category_name TEXT NOT NULL,
  price        REAL NOT NULL,
  qr           TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);

CREATE TABLE waitlist (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL REFERENCES events(id),
  customer_id     INTEGER NOT NULL REFERENCES users(id),
  category_name   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'expired', 'claimed')),
  offer_token     TEXT,
  offer_expires_at INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_show_seats_event ON show_seats(event_id);
CREATE INDEX idx_show_seats_status ON show_seats(event_id, status);
CREATE INDEX idx_bookings_customer ON bookings(customer_id);
CREATE INDEX idx_waitlist_queue ON waitlist(event_id, category_name, status, created_at);