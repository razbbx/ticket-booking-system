-- Seed users (PBKDF2-SHA256, 100000 iterations, fixed 12-byte salts).
INSERT INTO users (name, email, password_hash, role) VALUES
('Admin', 'admin@example.com', 'pbkdf2$100000$c2VlZC1zYWx0LWFkbWlu$zOk4ELxjVJrNjan3Ct2BBIy0Hdv0cHLmMHzlwQBeEAg=', 'admin'),
('Organiser', 'organiser@example.com', 'pbkdf2$100000$c2VlZC1zYWx0LW9yZ2FuaXNlcg==$7y7UI2ulgZ9yYLKklQ+W4oD0Jy9vE1DTlmXl2zM+2oQ=', 'organiser'),
('Customer', 'customer@example.com', 'pbkdf2$100000$c2VlZC1zYWx0LWN1c3RvbWVy$oSPzbi4RhKLLofoui7uQYiXHeyAIv8wGaS6+Mn1bq3I=', 'customer');

-- Venue: Grand Cinemax, 8 rows x 10 cols. Premium owns the top 2 rows,
-- Standard (row_count 0) absorbs the remaining 6 rows.
INSERT INTO venues (name, address, rows, cols) VALUES ('Grand Cinemax', '12 Downtown', 8, 10);

INSERT INTO venue_categories (venue_id, category_name, row_count) VALUES
(1, 'Premium', 2),
(1, 'Standard', 0);

-- Events (organiser id 2, venue id 1).
INSERT INTO events (organiser_id, venue_id, title, type, date, time, description) VALUES
(2, 1, 'Inception (IMAX Re-release)', 'movie', '2026-09-01', '19:00', 'The mind-bending masterpiece returns to IMAX screens.'),
(2, 1, 'Midnight Strings Live', 'concert', '2026-09-05', '20:00', 'An evening of live orchestral music under the stars.');

INSERT INTO event_pricing (event_id, category_name, price) VALUES
(1, 'Premium', 500),
(1, 'Standard', 300),
(2, 'Premium', 500),
(2, 'Standard', 300);

-- 80 seats per event: rows 1-2 Premium, rows 3-8 Standard.
INSERT INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 8),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 10)
SELECT 1, r, c, CASE WHEN r <= 2 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;

INSERT INTO show_seats (event_id, seat_row, seat_col, category_name)
WITH RECURSIVE rgen(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM rgen WHERE r < 8),
     cgen(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM cgen WHERE c < 10)
SELECT 2, r, c, CASE WHEN r <= 2 THEN 'Premium' ELSE 'Standard' END
FROM rgen CROSS JOIN cgen;