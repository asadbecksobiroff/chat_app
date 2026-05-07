const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/users/search?q=username
 * Search users by username. Excludes the current user.
 */
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length === 0) {
      return res.json({ users: [] });
    }

    const searchTerm = `%${q.trim().toLowerCase()}%`;

    const { rows } = await pool.query(
      `SELECT id, username, display_name, avatar_url, is_online, last_seen
       FROM users
       WHERE (username ILIKE $1 OR display_name ILIKE $1)
         AND id != $2
       LIMIT 20`,
      [searchTerm, req.user.id]
    );

    res.json({ users: rows });
  } catch (err) {
    console.error('User search error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * GET /api/users/:id
 * Get a user's public profile by ID.
 */
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, display_name, avatar_url, bio, is_online, last_seen, created_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ user: rows[0] });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
