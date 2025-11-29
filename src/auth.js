// src/auth.js
const bcrypt = require('bcrypt');
const pool = require('./db');

async function registerUser(email, password, name) {
  const conn = await pool.getConnection();
  try {
    // Проверяем, есть ли уже такой email
    const [rows] = await conn.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    if (rows.length > 0) {
      return 'Этот email уже зарегистрирован';
    }

    const hash = await bcrypt.hash(password, 10);

    // Начинаем транзакцию
    await conn.beginTransaction();

    // Создаём пользователя
    const [userRes] = await conn.execute(
      'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)',
      [email, hash, name]
    );
    const userId = userRes.insertId;

    // Создаём семью
    const [familyRes] = await conn.execute(
      'INSERT INTO families (name) VALUES (?)',
      ['Наша семья']
    );
    const familyId = familyRes.insertId;

    // Добавляем пользователя как владельца
    await conn.execute(
      'INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, "owner")',
      [familyId, userId]
    );

    // Создаём один счёт
    await conn.execute(
      'INSERT INTO accounts (family_id, name) VALUES (?, ?)',
      [familyId, 'Основная карта']
    );

    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return 'Ошибка при регистрации';
  } finally {
    conn.release();
  }
}

async function loginUser(email, password) {
  const [rows] = await pool.execute(
    'SELECT * FROM users WHERE email = ?',
    [email]
  );

  if (rows.length === 0) {
    return { error: 'Пользователь не найден' };
  }

  const user = rows[0];
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return { error: 'Неверный пароль' };
  }

  return { user };
}

async function getUserById(id) {
  const [rows] = await pool.execute(
    'SELECT * FROM users WHERE id = ?',
    [id]
  );
  return rows[0] || null;
}

async function getUserFamilyId(userId) {
  const [rows] = await pool.execute(
    `
    SELECT f.id
    FROM families f
    JOIN family_members fm ON fm.family_id = f.id
    WHERE fm.user_id = ?
    LIMIT 1
    `,
    [userId]
  );
  return rows[0]?.id || null;
}

async function getFamilyMainAccountId(familyId) {
  const [rows] = await pool.execute(
    `
    SELECT id
    FROM accounts
    WHERE family_id = ?
    ORDER BY id ASC
    LIMIT 1
    `,
    [familyId]
  );
  return rows[0]?.id || null;
}

module.exports = {
  registerUser,
  loginUser,
  getUserById,
  getUserFamilyId,
  getFamilyMainAccountId,
};
