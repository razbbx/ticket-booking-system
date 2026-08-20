'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, verifyPassword, issueToken } = require('../auth');

// Admins are provisioned by the seed script; public registration may only
// create customer or organiser accounts.
const ALLOWED_ROLES = ['customer', 'organiser'];

router.post('/register', (req, res) => {
  const { name, email, password, role = 'customer' } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role must be customer or organiser (admin is provisioned via seed)' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'email already registered' });
  }

  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run(name, email, hashPassword(password), role, Date.now());
  const user = db
    .prepare('SELECT id, name, email, role FROM users WHERE id = ?')
    .get(info.lastInsertRowid);
  res.status(201).json({ token: issueToken(user), user });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const safe = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.json({ token: issueToken(safe), user: safe });
});

module.exports = router;