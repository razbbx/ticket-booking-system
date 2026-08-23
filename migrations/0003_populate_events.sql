-- Populate additional venues, events, pricing, and show seats

-- Venues
INSERT OR IGNORE INTO venues (id, name, address, rows, cols) VALUES
(2, 'Starlight Arena', '45 Park Boulevard', 10, 12),
(3, 'Royal Symphony Hall', '88 Cultural Center Plaza', 8, 8);

INSERT OR IGNORE INTO venue_categories (venue_id, category_name, row_count) VALUES
(2, 'Premium', 3),
(2, 'Standard', 0),
(3, 'Premium', 2),
(3, 'Standard', 0);

-- Events (Organiser ID 2)
INSERT OR IGNORE INTO events (id, organiser_id, venue_id, title, type, date, time, description) VALUES
(3, 2, 2, 'Interstellar: Live in Concert', 'concert', '2026-09-12', '19:30', 'Hans Zimmer score performed live by an 80-piece orchestra alongside the sci-fi epic on the giant screen.'),
(4, 2, 1, 'Avatar: Fire & Ash Preview', 'movie', '2026-09-18', '18:00', 'Exclusive early 3D HFR fan preview event with director intro and Q&A session.'),
(5, 2, 2, 'Coldplay: Music of the Spheres', 'concert', '2026-09-25', '21:00', 'Spectacular arena tour featuring LED wristband lightshows, eco-fireworks, and global hits.'),
(6, 2, 3, 'The Dark Knight (70mm IMAX)', 'movie', '2026-10-02', '20:30', 'Special 70mm IMAX film print anniversary screening of Christopher Nolan legendary masterpiece.');

-- Pricing
INSERT OR IGNORE INTO event_pricing (event_id, category_name, price) VALUES
(3, 'Premium', 650),
(3, 'Standard', 400),
(4, 'Premium', 750),
(4, 'Standard', 450),
(5, 'Premium', 1200),
(5, 'Standard', 600),
(6, 'Premium', 550),
(6, 'Standard', 350);

-- Populate Show Seats for Event 3 (Venue 2: 10 rows x 12 cols = 120 seats)
INSERT OR IGNORE INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 0 UNION ALL SELECT r + 1 FROM rgen WHERE r < 9),
     cgen(c) AS (SELECT 0 UNION ALL SELECT c + 1 FROM cgen WHERE c < 11)
SELECT 3, r, c, CASE WHEN r < 3 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Populate Show Seats for Event 4 (Venue 1: 8 rows x 10 cols = 80 seats)
INSERT OR IGNORE INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 0 UNION ALL SELECT r + 1 FROM rgen WHERE r < 7),
     cgen(c) AS (SELECT 0 UNION ALL SELECT c + 1 FROM cgen WHERE c < 9)
SELECT 4, r, c, CASE WHEN r < 2 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Populate Show Seats for Event 5 (Venue 2: 10 rows x 12 cols = 120 seats)
INSERT OR IGNORE INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 0 UNION ALL SELECT r + 1 FROM rgen WHERE r < 9),
     cgen(c) AS (SELECT 0 UNION ALL SELECT c + 1 FROM cgen WHERE c < 11)
SELECT 5, r, c, CASE WHEN r < 3 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Populate Show Seats for Event 6 (Venue 3: 8 rows x 8 cols = 64 seats)
INSERT OR IGNORE INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 0 UNION ALL SELECT r + 1 FROM rgen WHERE r < 7),
     cgen(c) AS (SELECT 0 UNION ALL SELECT c + 1 FROM cgen WHERE c < 7)
SELECT 6, r, c, CASE WHEN r < 2 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;
