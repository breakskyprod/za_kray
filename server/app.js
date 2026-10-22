require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================
//  КОНФИГУРАЦИЯ И ПРОВЕРКА ОКРУЖЕНИЯ
// =============================================
// STATS_KEY обязателен. Без него приватная статистика была бы
// защищена предсказуемым дефолтом — поэтому падаем на старте.
const STATS_KEY = process.env.STATS_KEY;
if (!STATS_KEY || STATS_KEY.length < 16) {
    console.error('❌ Переменная окружения STATS_KEY не задана или слишком короткая (нужно >= 16 символов).');
    console.error('   Создайте .env на основе .env.example и задайте надёжный ключ.');
    process.exit(1);
}

// Разрешённые источники для CORS. Список доменов через запятую в ALLOWED_ORIGINS.
// Фронтенд ходит по относительным путям (один домен), поэтому для самого сайта
// CORS не требуется — этот список нужен только если API дёргают извне.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const corsOptions = {
    origin: (origin, callback) => {
        // Запросы без Origin (тот же домен, curl, мобильные вебвью) — разрешаем.
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.length === 0) return callback(null, true); // dev-режим
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error('CORS: источник не разрешён'));
    }
};
app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '256kb' })); // прогресс зрителя — маленький JSON

// =============================================
//  СТАТИКА (Фронтенд и Видео)
// =============================================
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// В продакшене видео раздаёт Nginx напрямую (см. deploy/nginx.conf).
// Этот обработчик — запасной вариант для локальной разработки.
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    maxAge: '1y',
    immutable: true,
    setHeaders: (res) => {
        res.setHeader('Accept-Ranges', 'bytes');
    }
}));

// =============================================
//  АТОМАРНАЯ ЗАПИСЬ + ОЧЕРЕДЬ (устранение гонки)
// =============================================
// Проблема: fs.writeFileSync на каждый запрос + read-modify-write приводит
// к потере данных при одновременных запросах. Решение:
//   1) все изменения к одному файлу выполняются последовательно (очередь промисов);
//   2) запись атомарна: пишем во временный файл и делаем rename (на одной ФС это атомарно).

function atomicWrite(filePath, text) {
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
}

// Очередь операций на каждый файл: гарантирует, что read→modify→write
// по одному файлу не пересекаются между параллельными запросами.
const fileQueues = new Map();
function enqueue(filePath, task) {
    const prev = fileQueues.get(filePath) || Promise.resolve();
    const next = prev.then(task, task); // выполняем task даже если предыдущая упала
    // чистим цепочку, но не ломаем её при ошибке
    fileQueues.set(filePath, next.catch(() => {}));
    return next;
}

// =============================================
//  СЕРИАЛ (JSON) — кэшируется в памяти
// =============================================
const SERIES_FILE_NAME = process.env.SERIES_FILE || 'series_v2.json';
const DATA_FILE = path.join(__dirname, 'data', SERIES_FILE_NAME);

let seriesCache = null;
function loadSeries() {
    // Сериал меняется редко — читаем один раз и держим в памяти.
    if (seriesCache) return seriesCache;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    seriesCache = JSON.parse(raw);
    return seriesCache;
}
console.log(`📖 Сериал: ${SERIES_FILE_NAME}`);

// =============================================
//  СТАТИСТИКА И ПРОГРЕСС
// =============================================
const VIEWS_FILE = path.join(__dirname, 'data', 'views.json');
const STATES_FILE = path.join(__dirname, 'data', 'states.json');

function loadViews() {
    try {
        const data = JSON.parse(fs.readFileSync(VIEWS_FILE, 'utf8'));
        return {
            total: data.total || 0,
            viewers: data.viewers || {},
            lastUpdated: data.lastUpdated || null
        };
    } catch (e) {
        return { total: 0, viewers: {}, lastUpdated: null };
    }
}

function loadStates() {
    try {
        return JSON.parse(fs.readFileSync(STATES_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

// Валидация viewerId: строка, разумная длина, безопасные символы.
function isValidViewerId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[\w-]+$/.test(id);
}

// --- API: Статистика ---
app.post('/api/stats/view', (req, res) => {
    const { viewerId, type } = req.body || {};
    if (type !== 'start') return res.json({ success: true, skipped: true });

    enqueue(VIEWS_FILE, () => {
        const views = loadViews();
        views.total = (views.total || 0) + 1;
        if (isValidViewerId(viewerId) && !views.viewers[viewerId]) {
            views.viewers[viewerId] = new Date().toISOString();
        }
        views.lastUpdated = new Date().toISOString();
        atomicWrite(VIEWS_FILE, JSON.stringify(views, null, 2));
    })
        .then(() => res.json({ success: true }))
        .catch(() => res.status(500).json({ error: 'Ошибка сохранения статистики' }));
});

// Приватная статистика: ключ принимается через заголовок Authorization: Bearer <key>
// (не попадает в логи URL). Поддержан и старый ?key= для обратной совместимости.
function checkStatsKey(req) {
    const auth = req.get('authorization') || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const provided = bearer || req.query.key;
    return provided === STATS_KEY;
}

app.get('/api/stats', (req, res) => {
    if (!checkStatsKey(req)) {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    const views = loadViews();
    res.json({
        total: views.total,
        unique: Object.keys(views.viewers || {}).length,
        lastUpdated: views.lastUpdated
    });
});

app.get('/api/stats/public', (req, res) => {
    try {
        const views = loadViews();
        res.json({ unique: Object.keys(views.viewers || {}).length, total: views.total || 0 });
    } catch (err) {
        res.json({ unique: 0, total: 0 });
    }
});

// --- API: Прогресс зрителя ---
app.post('/api/state/save', (req, res) => {
    const { viewerId, state } = req.body || {};
    if (!isValidViewerId(viewerId) || !state || typeof state !== 'object') {
        return res.status(400).json({ error: 'Неверные данные' });
    }

    enqueue(STATES_FILE, () => {
        const states = loadStates();
        if (Object.keys(state).length === 0) {
            delete states[viewerId];
        } else {
            states[viewerId] = { ...state, updatedAt: new Date().toISOString() };
        }
        atomicWrite(STATES_FILE, JSON.stringify(states, null, 2));
    })
        .then(() => res.json({ success: true }))
        .catch(() => res.status(500).json({ error: 'Ошибка сохранения' }));
});

app.get('/api/state/:viewerId', (req, res) => {
    if (!isValidViewerId(req.params.viewerId)) {
        return res.status(400).json({ error: 'Неверный идентификатор' });
    }
    try {
        const states = loadStates();
        const state = states[req.params.viewerId];
        if (!state) return res.status(404).json({ error: 'Не найдено' });
        res.json(state);
    } catch (err) {
        res.status(500).json({ error: 'Ошибка чтения' });
    }
});

// =============================================
//  API СЕРИАЛА
// =============================================
app.get('/api/series', (req, res) => {
    try {
        const series = loadSeries();
        const episodes = series.episodes.map(ep => ({
            id: ep.id,
            episode_number: ep.episode_number,
            title: ep.title,
            cover: ep.cover || ''
        }));
        res.json({
            id: series.id, title: series.title, year: series.year || null,
            description: series.description, age_rating: series.age_rating,
            genres: series.genres || [], trailer: series.trailer || '',
            info: series.info || {}, episodes
        });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка чтения сериала' });
    }
});

app.get('/api/episode/:id', (req, res) => {
    try {
        const series = loadSeries();
        const ep = series.episodes.find(e => e.id == req.params.id);
        if (!ep) return res.status(404).json({ error: 'Серия не найдена' });
        res.json(ep);
    } catch (err) {
        res.status(500).json({ error: 'Ошибка чтения' });
    }
});

app.get('/api/scene/:id', (req, res) => {
    try {
        const series = loadSeries();
        const sceneId = req.params.id;
        for (const ep of series.episodes) {
            const s = (ep.scenes || []).find(s => s.id === sceneId);
            if (s) return res.json({ ...s, episode_id: ep.id, episode_number: ep.episode_number });
        }
        res.status(404).json({ error: 'Сцена не найдена' });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка чтения' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📁 Видео: ${path.join(__dirname, 'uploads')}`);
    console.log(`🔐 CORS: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'открыт (dev-режим)'}`);
});
