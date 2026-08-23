-- Populate 6 additional high-profile events (total 12 events)

INSERT OR IGNORE INTO events (id, organiser_id, venue_id, title, type, date, time, description) VALUES
(7, 2, 2, 'Taylor Swift | The Eras Tour', 'concert', '2026-09-30', '19:00', 'The record-breaking global stadium phenomenon featuring 3+ hours of pop hits and acoustic surprises.'),
(8, 2, 1, 'Dune: Part Two (IMAX 70mm)', 'movie', '2026-10-05', '20:00', 'Denis Villeneuve sci-fi spectacle experienced in native 1.43:1 expanded IMAX 70mm aspect ratio.'),
(9, 2, 2, 'Sunburn Festival Goa 2026', 'concert', '2026-10-12', '18:00', 'Asia premier outdoor electronic dance music festival featuring world-class DJ headliners and pyro laser shows.'),
(10, 2, 2, 'Oasis Live 26 World Tour', 'concert', '2026-10-20', '20:30', 'Liam and Noel Gallagher reunite for an iconic historic stadium rock reunion concert experience.'),
(11, 2, 3, 'Spider-Man: Beyond Spider-Verse', 'movie', '2026-10-28', '19:15', 'Exclusive early IMAX fan premiere of the highly anticipated animated trilogy finale with creator intro.'),
(12, 2, 3, 'AR Rahman: Symphony of India', 'concert', '2026-11-05', '19:30', 'Oscar-winning maestro AR Rahman leads a 100-piece orchestral celebration of iconic soundtrack classics.');

-- Event Pricing for Events 7-12
INSERT OR IGNORE INTO event_pricing (event_id, category_name, price) VALUES
(7, 'Premium', 1500), (7, 'Standard', 800),
(8, 'Premium', 600),  (8, 'Standard', 380),
(9, 'VIP', 2000),      (9, 'General', 1000),
(10, 'Premium', 1800), (10, 'Standard', 950),
(11, 'Premium', 500), (11, 'Standard', 320),
(12, 'VIP', 1400),     (12, 'General', 700);

-- Populate Show Seats for Event 7 (Venue 2: 40 rows x 60 cols = 2,400 seats)
INSERT OR IGNORE INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 40),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 60)
SELECT 7, r, c, CASE WHEN r <= 8 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Populate Show Seats for Event 8 (Venue 1: 16 rows x 16 cols = 256 seats)
INSERT OR IGNORE INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 16),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 16)
SELECT 8, r, c, CASE WHEN r <= 3 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Populate Show Seats for Event 9 (Venue 2: 40 rows x 60 cols = 2,400 seats)
INSERT OR IGNORE INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 40),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 60)
SELECT 9, r, c, CASE WHEN r <= 8 THEN 'VIP' ELSE 'General' END
FROM rgen CROSS JOIN cgen;

-- Populate Show Seats for Event 10 (Venue 2: 40 rows x 60 cols = 2,400 seats)
INSERT OR IGNORE INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 40),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 60)
SELECT 10, r, c, CASE WHEN r <= 8 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Populate Show Seats for Event 11 (Venue 1: 16 rows x 16 cols = 256 seats)
INSERT OR IGNORE INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 16),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 16)
SELECT 11, r, c, CASE WHEN r <= 3 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Populate Show Seats for Event 12 (Venue 3: 35 rows x 50 cols = 1,750 seats)
INSERT OR IGNORE INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 35),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 50)
SELECT 12, r, c, CASE WHEN r <= 6 THEN 'VIP' ELSE 'General' END
FROM rgen CROSS JOIN cgen;
