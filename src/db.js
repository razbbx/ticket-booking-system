'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Single shared connection. WAL + serialized writes keep concurrent requests safe.
const db = new Database(path.join(dataDir, 'tickets.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('customer', 'organiser', 'admin')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS venues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  address    TEXT,
  rows       INTEGER NOT NULL,
  cols       INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- Categories are defined per venue. row_count controls how many top rows
-- belong to each category (0 = "remaining rows"), used when seeding show_seats.
CREATE TABLE IF NOT EXISTS venue_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id      INTEGER NOT NULL REFERENCES venues(id),
  category_name TEXT NOT NULL,
  description   TEXT,
  row_count     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (venue_id, category_name)
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  organiser_id INTEGER NOT NULL REFERENCES users(id),
  venue_id     INTEGER NOT NULL REFERENCES venues(id),
  title        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('movie', 'concert')),
  date         TEXT NOT NULL,
  time         TEXT NOT NULL,
  description  TEXT,
  image_url    TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_pricing (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id),
  category_name TEXT NOT NULL,
  price         REAL NOT NULL,
  UNIQUE (event_id, category_name)
);

CREATE TABLE IF NOT EXISTS show_seats (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL REFERENCES events(id),
  venue_row       INTEGER NOT NULL,
  venue_col       INTEGER NOT NULL,
  category_name   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
  held_by         INTEGER REFERENCES users(id),
  hold_token      TEXT,
  hold_expires_at INTEGER,
  UNIQUE (event_id, venue_row, venue_col)
);

CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_ref  TEXT NOT NULL UNIQUE,
  event_id     INTEGER NOT NULL REFERENCES events(id),
  customer_id  INTEGER NOT NULL REFERENCES users(id),
  seat_id      INTEGER NOT NULL REFERENCES show_seats(id),
  category_name TEXT NOT NULL,
  price        REAL NOT NULL,
  qr_data      TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at   INTEGER NOT NULL,
  cancelled_at INTEGER
);

CREATE TABLE IF NOT EXISTS waitlist (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL REFERENCES events(id),
  customer_id     INTEGER NOT NULL REFERENCES users(id),
  category_name   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'claimed', 'expired')),
  offer_token     TEXT,
  offer_expires_at INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_show_seats_event_status ON show_seats(event_id, status);
CREATE INDEX IF NOT EXISTS idx_show_seats_event_cat_status ON show_seats(event_id, category_name, status);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_event ON bookings(event_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_event_cat ON waitlist(event_id, category_name, status);
CREATE INDEX IF NOT EXISTS idx_waitlist_offer_token ON waitlist(offer_token);
CREATE INDEX IF NOT EXISTS idx_events_organiser ON events(organiser_id);
CREATE INDEX IF NOT EXISTS idx_events_venue ON events(venue_id);
CREATE INDEX IF NOT EXISTS idx_venues_created_by ON venues(created_by);
`);

module.exports = db;
