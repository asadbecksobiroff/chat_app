const jwt = require('jsonwebtoken');
const pool = require('../db');
require('dotenv').config();

function registerSocketHandlers(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch (err) {
      return next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.user.id;
    const username = socket.user.username;
    console.log(`User connected: ${username} (${userId})`);

    await pool.query('UPDATE users SET is_online = TRUE, last_seen = NOW() WHERE id = $1', [userId]);
    socket.join(`user:${userId}`);
    io.emit('user:online', { userId });

    socket.on('chat:join', async ({ chatId }) => {
      try {
        const { rows } = await pool.query(
          'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
          [chatId, userId]
        );
        if (rows.length === 0) return socket.emit('error', { message: 'Not a participant.' });

        socket.join(`chat:${chatId}`);

        // Get unread messages
        const { rows: unread } = await pool.query(
          `SELECT id FROM messages
           WHERE chat_id = $1 AND sender_id != $2
             AND id NOT IN (SELECT message_id FROM message_reads WHERE user_id = $3)`,
          [chatId, userId, userId]
        );

        if (unread.length > 0) {
          // Mark as read
          const values = unread.map((m, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
          const params = unread.flatMap(m => [m.id, userId]);
          await pool.query(
            `INSERT INTO message_reads (message_id, user_id) VALUES ${values} ON CONFLICT DO NOTHING`,
            params
          );
          io.to(`chat:${chatId}`).emit('messages:read', { chatId, userId, messageIds: unread.map(m => m.id) });
        }
      } catch (err) {
        console.error('chat:join error:', err);
        socket.emit('error', { message: 'Failed to join chat.' });
      }
    });

    socket.on('chat:leave', ({ chatId }) => { socket.leave(`chat:${chatId}`); });

    socket.on('message:send', async ({ chatId, content, type = 'text' }) => {
      try {
        if (!content || !content.trim()) return socket.emit('error', { message: 'Empty message.' });

        const { rows: partRows } = await pool.query(
          'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
          [chatId, userId]
        );
        if (partRows.length === 0) return socket.emit('error', { message: 'Not a participant.' });

        const sanitized = content.trim().substring(0, 5000);

        const { rows: msgRows } = await pool.query(
          `INSERT INTO messages (chat_id, sender_id, content, message_type) VALUES ($1, $2, $3, $4) RETURNING id`,
          [chatId, userId, sanitized, type]
        );

        const { rows: fullMsg } = await pool.query(
          `SELECT m.*, u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
           FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
          [msgRows[0].id]
        );

        const message = fullMsg[0];
        message.readBy = [];

        io.to(`chat:${chatId}`).emit('message:new', message);

        const { rows: parts } = await pool.query(
          'SELECT user_id FROM chat_participants WHERE chat_id = $1',
          [chatId]
        );
        for (const p of parts) {
          io.to(`user:${p.user_id}`).emit('chat:updated', { chatId, lastMessage: message });
        }
      } catch (err) {
        console.error('message:send error:', err);
        socket.emit('error', { message: 'Failed to send message.' });
      }
    });

    socket.on('typing:start', ({ chatId }) => { socket.to(`chat:${chatId}`).emit('typing:start', { userId, username }); });
    socket.on('typing:stop', ({ chatId }) => { socket.to(`chat:${chatId}`).emit('typing:stop', { userId }); });

    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${username} (${userId})`);
      await pool.query('UPDATE users SET is_online = FALSE, last_seen = NOW() WHERE id = $1', [userId]);
      const { rows } = await pool.query('SELECT last_seen FROM users WHERE id = $1', [userId]);
      io.emit('user:offline', { userId, lastSeen: rows[0] ? rows[0].last_seen : new Date().toISOString() });
    });
  });
}

module.exports = registerSocketHandlers;
