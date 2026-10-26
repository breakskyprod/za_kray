// ============================================================
//  ФРАГМЕНТ ДЛЯ server/app.js — каталог постеров
//  Вставьте этот блок рядом с другими маршрутами (до app.listen).
//  Сейчас — только чтение (GET). Запись (POST) добавим вместе
//  с админ-панелью, когда согласуем её работу.
// ============================================================

const CATALOG_FILE = path.join(__dirname, 'data', 'catalog.json');

function loadCatalog() {
    try {
        const data = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
        return { items: Array.isArray(data.items) ? data.items : [] };
    } catch (e) {
        return { items: [] };
    }
}

// GET /api/catalog — список постеров для карусели на главной.
// Отдаём только то, что нужно фронту (без внутренних полей).
app.get('/api/catalog', (req, res) => {
    const catalog = loadCatalog();
    const items = catalog.items.map(it => ({
        id: it.id,
        type: it.type || 'clip',
        title: it.title || '',
        poster: it.poster || '',
        locked: !!it.locked,
        href: it.href || '',
        badge: it.badge || ''
    }));
    res.json({ items });
});

/* -----------------------------------------------------------
   НА БУДУЩЕЕ (админ-панель). Черновик защищённого добавления:

   app.post('/api/catalog', (req, res) => {
       // 1) проверить ключ/сессию администратора
       //    (например, заголовок Authorization: Bearer <ADMIN_KEY>)
       // 2) провалидировать поля item
       // 3) через очередь + атомарную запись (как в states/views)
       //    добавить item в catalog.json
       // 4) вернуть обновлённый список
   });
----------------------------------------------------------- */
