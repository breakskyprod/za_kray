const path = require('path');
// .env ищем рядом с app.js, а не в текущей папке запуска
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const { accessGate } = require('./access');
const { mountAdmin } = require('./admin');
const { buildPlayerSeries, publishedEpisodes, ZAKRAY_ID } = require('./projects');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================
//  КОНФИГУРАЦИЯ И ПРОВЕРКА ОКРУЖЕНИЯ
// =============================================
const STATS_KEY = process.env.STATS_KEY;
if (!STATS_KEY || STATS_KEY.length < 16) {
    console.error('❌ Переменная окружения STATS_KEY не задана или слишком короткая (нужно >= 16 символов).');
    console.error('   Создайте server/.env на основе .env.example и задайте надёжный ключ.');
    process.exit(1);
}

// За Nginx нужно доверять одному прокси, чтобы req.ip был реальным IP посетителя.
// Без этого лимит попыток пароля будет общим для всех (все запросы приходят с IP Nginx).
// TRUST_PROXY=0 — если сервер открыт напрямую без прокси.
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined ? Number(process.env.TRUST_PROXY) : 1;
app.set('trust proxy', TRUST_PROXY);

// Разрешённые источники для CORS (через запятую). Пусто = открыто (dev-режим).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.length === 0) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error('CORS: источник не разрешён'));
    }
};

app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '256kb' }));

// =============================================
//  ДОСТУП К ЗАКРЫТЫМ СТРАНИЦАМ
//  Должен стоять ДО express.static, иначе /series.html отдастся без проверки.
// =============================================
accessGate(app, { catalogFile: path.join(__dirname, 'data', 'catalog.json') });

// =============================================
//  АДМИНКА (загрузка роликов, интерактив, публикация)
//  Исходники хранятся в server/private и наружу не отдаются.
// =============================================
mountAdmin(app, {
    dataDir: path.join(__dirname, 'data'),
    uploadsDir: path.join(__dirname, 'uploads'),
    privateDir: path.join(__dirname, 'private'),
    frontendDir: path.join(__dirname, '..', 'frontend')
});

// =============================================
//  СТАТИКА (фронтенд и видео)
// =============================================
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// В продакшене видео раздаёт Nginx напрямую (deploy/nginx.conf).
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
function atomicWrite(filePath, text) {
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
}

const fileQueues = new Map();
function enqueue(filePath, task) {
    const prev = fileQueues.get(filePath) || Promise.resolve();
    const next = prev.then(task, task);
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
    if (seriesCache) return seriesCache;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    seriesCache = JSON.parse(raw);
    return seriesCache;
}
console.log(`📖 Сериал: ${SERIES_FILE_NAME}`);

// =============================================
//  ОПУБЛИКОВАННЫЕ ПРОЕКТЫ (серии из редактора)
//  Без ?p= отдаётся «За край» (series_v2), с ?p=<pid> — опубликованный проект.
// =============================================
const PROJECTS_FILE = path.join(__dirname, 'data', 'series_projects.json');
const PROJECTS_FRAGS_FILE = path.join(__dirname, 'data', 'projects.json');
const PID_RE = /^[a-f0-9]{16}$/;

function seriesFor(req) {
    const pid = req.query.p;
    if (!pid) return loadSeries();
    if (typeof pid !== 'string' || !PID_RE.test(pid)) return null;
    try {
        const store = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
        const p = store.projects && store.projects[pid];
        if (!p || !p.published) return null;
        const fragsDoc = JSON.parse(fs.readFileSync(PROJECTS_FRAGS_FILE, 'utf8'));
        const frags = fragsDoc.fragments || {};
        return buildPlayerSeries(p, frags);
    } catch (e) {
        return null;
    }
}

// Все проекты-серии (для списка эпизодов и перехода)
function readSeriesStore() {
    try {
        return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
        return { projects: {} };
    }
}

// =============================================
//  КАТАЛОГ ПРОЕКТОВ (карусель на главной)
// =============================================
const CATALOG_FILE = path.join(__dirname, 'data', 'catalog.json');

function loadCatalog() {
    try {
        const data = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
        return Array.isArray(data.items) ? data.items : [];
    } catch (e) {
        return [];
    }
}

// GET /api/catalog — карточки для главной, только публичные поля
app.get('/api/catalog', (req, res) => {
    const items = loadCatalog().map(it => ({
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

function isValidViewerId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[\w-]+$/.test(id);
}

// --- Статистика просмотров ---
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

// Приватная статистика: Authorization: Bearer <STATS_KEY> (или старый ?key=)
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

// --- Прогресс зрителя ---
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
        const state = loadStates()[req.params.viewerId];
        if (!state) return res.status(404).json({ error: 'Не найдено' });
        res.json(state);
    } catch (err) {
        res.status(500).json({ error: 'Ошибка чтения' });
    }
});

// =============================================
//  API СЕРИАЛА (?p=<pid> — опубликованный проект)
// =============================================
app.get('/api/series', (req, res) => {
    try {
        const series = seriesFor(req);
        if (!series) return res.status(404).json({ error: 'Серия не найдена' });

        let episodes = series.episodes.map(ep => ({
            id: ep.id,
            episode_number: ep.episode_number,
            title: ep.title,
            cover: ep.cover || ''
        }));
        // «За край» без ?p=: список серий берётся из опубликованных проектов сериала
        if (!req.query.p) {
            const list = publishedEpisodes(readSeriesStore(), ZAKRAY_ID);
            if (list.length) {
                episodes = list.map(p => ({
                    id: p.id,
                    episode_number: p.episodeNumber,
                    title: p.title,
                    cover: p.cover || '',
                    href: `/player_v2.html?p=${p.id}`
                }));
            }
        }

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

// GET /api/next-episode/:pid — следующая серия того же сериала или null
app.get('/api/next-episode/:pid', (req, res) => {
    if (!PID_RE.test(req.params.pid)) return res.status(400).json({ error: 'Неверный id' });
    const store = readSeriesStore();
    const cur = store.projects[req.params.pid];
    if (!cur || !cur.published || !cur.seriesId) return res.json({ next: null });
    const next = publishedEpisodes(store, cur.seriesId)
        .find(p => p.episodeNumber === cur.episodeNumber + 1);
    res.json({ next: next ? { id: next.id, href: `/player_v2.html?p=${next.id}` } : null });
});

app.get('/api/episode/:id', (req, res) => {
    try {
        const series = seriesFor(req);
        if (!series) return res.status(404).json({ error: 'Серия не найдена' });
        const ep = series.episodes.find(e => e.id == req.params.id);
        if (!ep) return res.status(404).json({ error: 'Серия не найдена' });
        res.json(ep);
    } catch (err) {
        res.status(500).json({ error: 'Ошибка чтения' });
    }
});

app.get('/api/scene/:id', (req, res) => {
    try {
        const series = seriesFor(req);
        if (!series) return res.status(404).json({ error: 'Сцена не найдена' });
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

// =============================================
//  ЗАПУСК
// =============================================
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📁 Видео: ${path.join(__dirname, 'uploads')}`);
    console.log(`🔐 CORS: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'открыт (dev-режим)'}`);
    console.log(`🛡  trust proxy: ${TRUST_PROXY}`);
});