-- Scale venue sizes & show_seats: 30x for concerts, 3x for movies

-- Clear old bookings & show_seats to re-generate scaled maps cleanly
DELETE FROM bookings;
DELETE FROM waitlist;
DELETE FROM show_seats;

-- Update venue dimensions
UPDATE venues SET rows = 16, cols = 16 WHERE id = 1; -- Grand Cinemax (Movie): 16x16 = 256 seats (~3x)
UPDATE venues SET rows = 40, cols = 60 WHERE id = 2; -- Starlight Arena (Concert): 40x60 = 2,400 seats (30x)
UPDATE venues SET rows = 35, cols = 50 WHERE id = 3; -- Royal Symphony Hall (Concert): 35x50 = 1,750 seats (30x)

-- Event 1: Inception (Movie - Venue 1: 16 rows x 16 cols = 256 seats)
INSERT INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 16),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 16)
SELECT 1, r, c, CASE WHEN r <= 3 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Event 2: Midnight Strings Live (Concert - Venue 2: 40 rows x 60 cols = 2,400 seats)
INSERT INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 40),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 60)
SELECT 2, r, c, CASE WHEN r <= 8 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Event 3: Interstellar Live (Concert - Venue 2: 40 rows x 60 cols = 2,400 seats)
INSERT INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 40),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 60)
SELECT 3, r, c, CASE WHEN r <= 8 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Event 4: Avatar Preview (Movie - Venue 1: 16 rows x 16 cols = 256 seats)
INSERT INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 16),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 16)
SELECT 4, r, c, CASE WHEN r <= 3 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Event 5: Coldplay (Concert - Venue 2: 40 rows x 60 cols = 2,400 seats)
INSERT INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 40),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 60)
SELECT 5, r, c, CASE WHEN r <= 8 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

-- Event 6: The Dark Knight (Movie - Venue 1: 16 rows x 16 cols = 256 seats)
INSERT INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 16),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 16)
SELECT 6, r, c, CASE WHEN r <= 3 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;
