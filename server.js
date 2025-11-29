const express = require('express');
const session = require('express-session');
const path = require('path');
const {
  registerUser,
  loginUser,
  getUserFamilyId,
  getFamilyMainAccountId,
} = require('./src/auth');
const { attachUser, requireLogin } = require('./src/middleware');
const pool = require('./src/db');

const app = express();

// Настройки
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: 'super-secret-key', // в реале вынести в env
    resave: false,
    saveUninitialized: false,
  })
);

// навешиваем текущего пользователя
app.use(attachUser);

// ================== РОУТЫ ==================

// Дашборд
app.get('/', requireLogin, async (req, res) => {
  const user = req.user;
  const userId = user.id;

  const familyId = await getUserFamilyId(userId);
  const accountId = await getFamilyMainAccountId(familyId);

  if (!familyId || !accountId) {
    return res.send('Не найдены семья или счёт.');
  }

  // Баланс
  const [balRows] = await pool.execute(
    `
    SELECT COALESCE(SUM(amount), 0) AS balance
    FROM transactions
    WHERE family_id = ? AND account_id = ?
    `,
    [familyId, accountId]
  );
  const balance = balRows[0].balance;

  // текущий месяц
  const fromDate = new Date();
  fromDate.setDate(1);
  const toDate = new Date(fromDate.getFullYear(), fromDate.getMonth() + 1, 0);

  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr = toDate.toISOString().slice(0, 10);

  // доходы
  const [incRows] = await pool.execute(
    `
    SELECT COALESCE(SUM(amount), 0) AS income
    FROM transactions
    WHERE family_id = ?
      AND account_id = ?
      AND amount > 0
      AND date BETWEEN ? AND ?
    `,
    [familyId, accountId, fromStr, toStr]
  );
  const income = incRows[0].income;

  // расходы
  const [expRows] = await pool.execute(
    `
    SELECT COALESCE(SUM(amount), 0) AS expense
    FROM transactions
    WHERE family_id = ?
      AND account_id = ?
      AND amount < 0
      AND date BETWEEN ? AND ?
    `,
    [familyId, accountId, fromStr, toStr]
  );
  const expense = expRows[0].expense;

  res.render('index', {
    user,
    balance,
    income,
    expense,
  });
});

// Регистрация
app.get('/register', (req, res) => {
  res.render('register', { message: null });
});

app.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  const result = await registerUser(email, password, name);

  if (result === true) {
    return res.redirect('/login');
  } else {
    return res.render('register', { message: result });
  }
});

// Логин
app.get('/login', (req, res) => {
  res.render('login', { message: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const result = await loginUser(email, password);
  if (result.error) {
    return res.render('login', { message: result.error });
  }

  req.session.userId = result.user.id;
  res.redirect('/');
});

// Логаут
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});


// ============ ТРАНЗАКЦИИ ============

// Страница со списком и формой
app.get('/transactions', requireLogin, async (req, res) => {
  const user = req.user;
  const userId = user.id;

  const familyId = await getUserFamilyId(userId);
  const accountId = await getFamilyMainAccountId(familyId);

  const { from, to, category_id } = req.query;

  let fromDate = from || null;
  let toDate = to || null;

  // по умолчанию текущий месяц
  if (!fromDate || !toDate) {
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    fromDate = fromDate || first.toISOString().slice(0, 10);
    toDate = toDate || last.toISOString().slice(0, 10);
  }

  // категории семьи (и общие)
  const [catRows] = await pool.execute(
    `
    SELECT * FROM categories
    WHERE family_id = ? OR family_id IS NULL
    ORDER BY name ASC
    `,
    [familyId]
  );

  // транзакции
  let query = `
    SELECT t.*, c.name AS category_name
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE t.family_id = ?
      AND t.account_id = ?
      AND t.date BETWEEN ? AND ?
  `;
  const params = [familyId, accountId, fromDate, toDate];

  if (category_id && category_id !== 'all') {
    query += ' AND t.category_id = ?';
    params.push(category_id);
  }

  query += ' ORDER BY t.date DESC, t.id DESC';

  const [txRows] = await pool.execute(query, params);

  res.render('transactions', {
    user,
    transactions: txRows,
    categories: catRows,
    filters: {
      from: fromDate,
      to: toDate,
      category_id: category_id || 'all',
    },
  });
});

// Добавление новой транзакции
app.post('/transactions', requireLogin, async (req, res) => {
  const user = req.user;
  const userId = user.id;

  const familyId = await getUserFamilyId(userId);
  const accountId = await getFamilyMainAccountId(familyId);

  const { date, amount, category_id, description, type, who } = req.body;

  let value = parseFloat(amount);
  if (type === 'expense' && value > 0) {
    value = -value;
  }

  const whoValue =
    who === 'me' || who === 'girlfriend' || who === 'shared'
      ? who
      : 'shared';

  await pool.execute(
    `
    INSERT INTO transactions
      (family_id, account_id, user_id, category_id, amount, date, description, who)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [familyId, accountId, userId, category_id, value, date, description || null, whoValue]
  );

  res.redirect('/transactions');
});



// ============ КАТЕГОРИИ ============

// Страница категорий
app.get('/categories', requireLogin, async (req, res) => {
  const user = req.user;
  const userId = user.id;

  const familyId = await getUserFamilyId(userId);

  // Берём общие категории (family_id IS NULL) и категории этой семьи
  const [rows] = await pool.execute(
    `
    SELECT *
    FROM categories
    WHERE family_id IS NULL OR family_id = ?
    ORDER BY type DESC, name ASC
    `,
    [familyId]
  );

  res.render('categories', {
    user,
    categories: rows,
    message: null,
  });
});

// Добавление новой категории
app.post('/categories', requireLogin, async (req, res) => {
  const user = req.user;
  const userId = user.id;
  const familyId = await getUserFamilyId(userId);

  let { name, type, color } = req.body;

  name = (name || '').trim();
  type = type === 'income' ? 'income' : 'expense';
  color = color || '#cccccc';

  if (!name) {
    // Можно сделать отображение ошибки, но пока просто редирект
    return res.redirect('/categories');
  }

  await pool.execute(
    `
    INSERT INTO categories (family_id, name, type, color)
    VALUES (?, ?, ?, ?)
    `,
    [familyId, name, type, color]
  );

  res.redirect('/categories');
});

// Обновление категории (Только своих)
app.post('/categories/update', requireLogin, async (req, res) => {
  const { id, name, type, color } = req.body;

  if (!id) {
    return res.redirect('/categories');
  }

  await pool.execute(
    `
    UPDATE categories
    SET name = ?, type = ?, color = ?
    WHERE id = ?
    `,
    [
      name.trim(),
      type === 'income' ? 'income' : 'expense',
      color || '#cccccc',
      id
    ]
  );

  res.redirect('/categories');
});


// Удаление категории (Только своих)
app.post('/categories/delete', requireLogin, async (req, res) => {
  const user = req.user;
  const userId = user.id;
  const familyId = await getUserFamilyId(userId);

  const { id } = req.body;
  if (!id) return res.redirect('/categories');

  // Удаляем только категории семьи (общие с family_id NULL не трогаем)
  await pool.execute(
    `
    DELETE FROM categories
    WHERE id = ? AND family_id = ?
    `,
    [id, familyId]
  );

  res.redirect('/categories');
});

// ============ КОНЕЦ КАТЕГОРИЙ ============


const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Сервер доступен по адресу -> http://localhost:${PORT}`);
});
