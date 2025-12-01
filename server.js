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

  // Баланс (все транзакции по счёту)
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

  // доходы за месяц
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

  // расходы за месяц (сумма отрицательных)
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
  const expense = expRows[0].expense; // это отрицательное число

  // расходы по категориям (делаем суммы положительными через -amount)
    const [catRows] = await pool.execute(
    `
    SELECT
      c.name AS category_name,
      c.color,
      c.icon,
      COALESCE(SUM(-t.amount), 0) AS total_spent
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE t.family_id = ?
      AND t.account_id = ?
      AND t.amount < 0
      AND t.date BETWEEN ? AND ?
    GROUP BY c.id, c.name, c.color, c.icon
    ORDER BY total_spent DESC
    `,
    [familyId, accountId, fromStr, toStr]
  );

  const categoriesSummaryRaw = catRows.map(row => ({
    name: row.category_name,
    total: Number(row.total_spent || 0),
    color: row.color || '#cccccc',
    icon: row.icon || 'bi-tag',
  }));

  const totalExpensesAbs = categoriesSummaryRaw.reduce(
    (sum, row) => sum + row.total,
    0
  );

    const categoriesSummary = categoriesSummaryRaw.map(row => ({
    name: row.name,
    total: row.total,
    color: row.color,
    icon: row.icon,
    percent:
      totalExpensesAbs > 0
        ? Math.round((row.total / totalExpensesAbs) * 1000) / 10
        : 0,
  }));

  res.render('index', {
    user,
    balance,
    income,
    expense,             // всё ещё отрицательное, обработаем в шаблоне
    categoriesSummary,
    totalExpensesAbs,
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
  SELECT t.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon
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

  let { name, type, color, icon } = req.body;

  name = (name || '').trim();
  type = type === 'income' ? 'income' : 'expense';
  color = color || '#cccccc';
  icon = icon || 'bi-tag';

  if (!name) {
    return res.redirect('/categories');
  }

  // 🔒 Проверяем, есть ли уже ТАКАЯ категория (имя+тип) либо общая, либо семейная
  const [existing] = await pool.execute(
    `
    SELECT id
    FROM categories
    WHERE (family_id IS NULL OR family_id = ?)
      AND name = ?
      AND type = ?
    LIMIT 1
    `,
    [familyId, name, type]
  );

  if (existing.length > 0) {
    // Категория уже есть (либо базовая, либо своя) — просто не создаём вторую
    // Можно потом добавить сообщение пользователю, пока просто редирект
    return res.redirect('/categories');
  }

  await pool.execute(
    `
    INSERT INTO categories (family_id, name, type, color, icon)
    VALUES (?, ?, ?, ?, ?)
    `,
    [familyId, name, type, color, icon]
  );

  res.redirect('/categories');
});


// Обновление категории (Только своих)
app.post('/categories/update', requireLogin, async (req, res) => {
  const user = req.user;
  const userId = user.id;
  const familyId = await getUserFamilyId(userId);

  let { id, name, type, color, icon } = req.body;

  if (!id) {
    return res.redirect('/categories');
  }

  name = (name || '').trim();
  type = type === 'income' ? 'income' : 'expense';
  color = color || '#cccccc';
  icon = icon || 'bi-tag';

  if (!name) {
    return res.redirect('/categories');
  }

  // 🔒 Проверяем, не превращаем ли мы эту категорию в дубль другой
  const [existing] = await pool.execute(
    `
    SELECT id
    FROM categories
    WHERE (family_id IS NULL OR family_id = ?)
      AND name = ?
      AND type = ?
      AND id <> ?
    LIMIT 1
    `,
    [familyId, name, type, id]
  );

  if (existing.length > 0) {
    // Уже есть другая категория с таким же именем+типом
    return res.redirect('/categories');
  }

  await pool.execute(
    `
    UPDATE categories
    SET name = ?, type = ?, color = ?, icon = ?
    WHERE id = ?
    `,
    [name, type, color, icon, id]
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

  try {
    // 1) Сначала удаляем все транзакции этой семьи с этой категорией
    await pool.execute(
      `
      DELETE FROM transactions
      WHERE family_id = ? AND category_id = ?
      `,
      [familyId, id]
    );

    // 2) Потом удаляем категорию
    await pool.execute(
      `
      DELETE FROM categories
      WHERE id = ? AND family_id = ?
      `,
      [id, familyId]
    );

    res.redirect('/categories');
  } catch (err) {
    console.error('Error deleting category:', err);
    res.status(500).send('Ошибка при удалении категории.');
  }
});


// ============ КОНЕЦ КАТЕГОРИЙ ============


// ============ ОЧИСТКА ДАННЫХ СЕМЬИ ============

app.post('/reset-data', requireLogin, async (req, res) => {
  const user = req.user;
  const userId = user.id;

  const familyId = await getUserFamilyId(userId);
  if (!familyId) {
    return res.redirect('/');
  }

  try {
    // Сначала удаляем ВСЕ транзакции семьи
    await pool.execute(
      'DELETE FROM transactions WHERE family_id = ?',
      [familyId]
    );

    // Потом удаляем пользовательские категории семьи
    await pool.execute(
      'DELETE FROM categories WHERE family_id = ?',
      [familyId]
    );

    // При желании можно сюда же добавить очистку других таблиц, если появятся

    res.redirect('/');
  } catch (err) {
    console.error('Error in /reset-data:', err);
    res.status(500).send('Ошибка при очистке данных.');
  }
});

// ==============================================


const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Сервер доступен по адресу -> http://localhost:${PORT}`);
});
