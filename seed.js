'use strict';

const db = require('./src/db');
const { hashPassword } = require('./src/auth');
const { createEventListing } = require('./src/routes/eventRoutes');

const USERS = [
  { name: 'Admin', email: 'admin@example.com', password: 'admin123', role: 'admin' },
  { name: 'Organiser', email: 'organiser@example.com', password: 'organiser123', role: 'organiser' },
  { name: 'Customer', email: 'customer@example.com', password: 'customer123', role: 'customer' },
];

for (const u of USERS) {
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(u.email);
  if (!exists) {
    db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,?,?)').run(
      u.name,
      u.email,
      hashPassword(u.password),
      u.role,
      Date.now()
    );
  }
}

const admin = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@example.com');

// Sample venue: 8 rows x 10 cols, rows 1-2 Premium, rows 3-8 Standard.
let venue = db.prepare('SELECT * FROM venues WHERE name = ?').get('Grand Cinemax');
if (!venue) {
  const vid = db
    .prepare('INSERT INTO venues (name, address, rows, cols, created_by, created_at) VALUES (?,?,?,?,?,?)')
    .run('Grand Cinemax', '123 Main Street', 8, 10, admin.id, Date.now()).lastInsertRowid;
  db.prepare('INSERT INTO venue_categories (venue_id, category_name, description, row_count) VALUES (?,?,?,?)').run(
    vid,
    'Premium',
    'Rows 1-2: extra legroom and premium seating',
    2
  );

  db.prepare('INSERT INTO venue_categories (venue_id, category_name, description, row_count) VALUES (?,?,?,?)').run(
    vid,
    'Standard',
    'Rows 3-8: standard seating',
    6
  );
  venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(vid);
}

const organiser = db.prepare('SELECT id FROM users WHERE email = ?').get('organiser@example.com');

const MOVIE_EVENT = {
  title: 'Inception: Anniversary Screening',
  type: 'movie',
  date: '2026-09-01',
  time: '19:00',
  description: '10th anniversary re-release of Inception.',
  pricing: { Premium: 500, Standard: 300 },
};

const CONCERT_EVENT = {
  title: 'Ae Dil Hai Mushkil Live',
  type: 'concert',
  date: '2026-09-15',
  time: '20:00',
  description: 'An evening of live music.',
  pricing: { Premium: 1500, Standard: 800 },
};

for (const ev of [MOVIE_EVENT, CONCERT_EVENT]) {
  const existing = db.prepare('SELECT id FROM events WHERE title = ?').get(ev.title);
  if (!existing) {
    createEventListing({
      organiser_id: organiser.id,
      venue_id: venue.id,
      title: ev.title,
      type: ev.type,
      date: ev.date,
      time: ev.time,
      description: ev.description,
      pricing: ev.pricing,
    });
  }
}

console.log('[seed] done: admin, organiser, customer + 1 venue (Grand Cinemax) + 2 events');