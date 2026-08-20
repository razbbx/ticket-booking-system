'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();

require('./src/db'); // creates the data directory, opens the DB and builds the schema
const { startHoldSweep } = require('./src/services/holds');

const authRoutes = require('./src/routes/authRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const { router: eventRoutes } = require('./src/routes/eventRoutes');
const seatRoutes = require('./src/routes/seatRoutes');
const waitlistRoutes = require('./src/routes/waitlistRoutes');
const bookingRoutes = require('./src/routes/bookingRoutes');

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serves the frontend build when a sibling "public" directory exists.
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

// Routers use absolute /api paths, so they are all mounted at the root.
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/', eventRoutes);
app.use('/', seatRoutes);
app.use('/', waitlistRoutes);
app.use('/', bookingRoutes);

app.use((req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const PORT = process.env.PORT || 3000;
startHoldSweep();
app.listen(PORT, () => console.log(`[server] listening on http://localhost:${PORT}`));