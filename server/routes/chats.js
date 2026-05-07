const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/chats
 * Get all chats for the current user with last message and other participant info.
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all chat IDs the user participates in
    const { rows: chatRows } = await pool.query(
      'SELECT chat_id FROM chat_participants WHERE user_id = $1',
      [userId]
    );

    if (chatRows.length === 0) {
      return res.json({ chats: [] });
    }

    const chats = [];

    for (const { chat_id: chatId } of chatRows) {
      // Get the other participant
      const { rows: userRows } = await pool.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_online, u.last_seen
         FROM chat_participants cp
         JOIN users u ON u.id = cp.user_id
         WHERE cp.chat_id = $1 AND cp.user_id != $2`,
        [chatId, userId]
      );

      if (userRows.length === 0) continue;
      const otherUser = userRows[0];

      // Get the last message
      const { rows: msgRows } = await pool.query(
        `SELECT id, sender_id, content, message_type, created_at
         FROM messages WHERE chat_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [chatId]
      );

      // Get unread count
      const { rows: unreadRows } = await pool.query(
        `SELECT COUNT(*) as count FROM messages
         WHERE chat_id = $1 AND sender_id != $2
           AND id NOT IN (SELECT message_id FROM message_reads WHERE user_id = $3)`,
        [chatId, userId, userId]
      );

      chats.push({
        id: chatId,
        otherUser,
        lastMessage: msgRows[0] || null,
        unreadCount: parseInt(unreadRows[0].count)
      });
    }

    // Sort by last message time (most recent first)
    chats.sort((a, b) => {
      const timeA = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0;
      const timeB = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0;
      return timeB - timeA;
    });

    res.json({ chats });
  } catch (err) {
    console.error('Get chats error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /api/chats
 * Create or get existing DM chat with a target user.
 */
router.post('/', async (req, res) => {
  try {
    const { targetUserId } = req.body;
    const userId = req.user.id;

    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId is required.' });
    }

    if (parseInt(targetUserId) === userId) {
      return res.status(400).json({ error: 'Cannot create a chat with yourself.' });
    }

    // Check target user exists
    const { rows: targetRows } = await pool.query('SELECT id FROM users WHERE id = $1', [targetUserId]);
    if (targetRows.length === 0) {
      return res.status(404).json({ error: 'Target user not found.' });
    }

    // Check if DM already exists between these two users
    const { rows: existingRows } = await pool.query(
      `SELECT cp1.chat_id
       FROM chat_participants cp1
       JOIN chat_participants cp2 ON cp1.chat_id = cp2.chat_id
       WHERE cp1.user_id = $1 AND cp2.user_id = $2`,
      [userId, parseInt(targetUserId)]
    );

    if (existingRows.length > 0) {
      const { rows: otherUserRows } = await pool.query(
        `SELECT id, username, display_name, avatar_url, is_online, last_seen
         FROM users WHERE id = $1`,
        [parseInt(targetUserId)]
      );

      return res.json({
        chat: {
          id: existingRows[0].chat_id,
          otherUser: otherUserRows[0],
          lastMessage: null,
          unreadCount: 0
        }
      });
    }

    // Create new chat inside a transaction
    const client = await pool.connect();
    let chatId;
    try {
      await client.query('BEGIN');
      const { rows: chatRows } = await client.query('INSERT INTO chats DEFAULT VALUES RETURNING id');
      chatId = chatRows[0].id;
      await client.query('INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)', [chatId, userId]);
      await client.query('INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)', [chatId, parseInt(targetUserId)]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    const { rows: otherUserRows } = await pool.query(
      `SELECT id, username, display_name, avatar_url, is_online, last_seen
       FROM users WHERE id = $1`,
      [parseInt(targetUserId)]
    );

    res.status(201).json({
      chat: {
        id: chatId,
        otherUser: otherUserRows[0],
        lastMessage: null,
        unreadCount: 0
      }
    });
  } catch (err) {
    console.error('Create chat error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * GET /api/chats/:id/messages
 * Get paginated messages for a chat. Cursor-based pagination.
 */
router.get('/:id/messages', async (req, res) => {
  try {
    const chatId = parseInt(req.params.id);
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before ? parseInt(req.query.before) : null;

    // Verify user is participant
    const { rows: partRows } = await pool.query(
      'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId]
    );

    if (partRows.length === 0) {
      return res.status(403).json({ error: 'You are not a participant of this chat.' });
    }

    let messages;
    if (before) {
      const { rows } = await pool.query(
        `SELECT m.*, u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.chat_id = $1 AND m.id < $2
         ORDER BY m.id DESC LIMIT $3`,
        [chatId, before, limit]
      );
      messages = rows;
    } else {
      const { rows } = await pool.query(
        `SELECT m.*, u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.chat_id = $1
         ORDER BY m.id DESC LIMIT $2`,
        [chatId, limit]
      );
      messages = rows;
    }

    // Check read status for each message
    for (let i = 0; i < messages.length; i++) {
      const { rows: readRows } = await pool.query(
        'SELECT user_id FROM message_reads WHERE message_id = $1',
        [messages[i].id]
      );
      messages[i].readBy = readRows.map(r => r.user_id);
    }

    // Reverse to get chronological order
    messages.reverse();

    const hasMore = messages.length === limit;

    res.json({ messages, hasMore });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
