// src/middleware.js
const { getUserById } = require('./auth');

async function attachUser(req, res, next) {
  if (req.session.userId) {
    req.user = await getUserById(req.session.userId);
  } else {
    req.user = null;
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

module.exports = { attachUser, requireLogin };
