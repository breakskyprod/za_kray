require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// =============================================
//  СТАТИКА С ЗАГОЛОВКАМИ КЭШИРОВАНИЯ
// =============================================
// Для фронтенда — обычная раздача
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Для видео и обложек — долгий кэш, чтобы прелоад работал
app.use('/uploads', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
}, express.static(path.join(__dirname, 'uploads')));

// Multer (на будущее)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, uuidv4() + ext);
    }
});
const upload = multer({ storage });

// =============================================
//  СЕРИАЛ
// =============================================
const SERIES_FILE_NAME = process.env.SERIES_FILE || 'series_v2.json';
const DATA_FILE = path.join(__dirname, 'data', SERIES_FILE_NAME);

function loadSeries() {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
}

console.log(`📖 Сериал: ${SERIES_FILE_NAME}`);

// =============================================
//  СТАТИСТИКА ПРОСМОТРОВ
// =============================================
const VIEWS_FILE = path.join(__dirname, 'data', 'views.json');
const STATS_KEY = process.env.STATS_KEY || 'series_stats_key';

function loadViews() {
    try {
        const raw = fs.readFileSync(VIEWS_FILE, 'utf8');
        const data = JSON.parse(raw);
        return {
            total: data.total || 0,
            viewers: data.viewers || {},
            lastUpdated: data.lastUpdated || null
        };
    } catch (e) {
        return { total: 0, viewers: {}, lastUpdated: null };
    }
}

function saveViews(data) {
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(VIEWS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// =============================================
//  ПРОГРЕСС ЗРИТЕЛЕЙ
// =============================================
const STATES_FILE = path.join(__dirname, 'data', 'states.json');

function loadStates() {
    try {
        return JSON.parse(fs.readFileSync(STATES_FILE, 'utf8'));
    } catch (e) { return {}; }
}

function saveStates(data) {
    fs.writeFileSync(STATES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// =============================================
//  API: СТАТИСТИКА
// =============================================
app.post('/api/stats/view', (req, res) => {
    const { viewerId, type } = req.body;
    if (type !== 'start') return res.json({ success: true, skipped: true });
    try {
        const views = loadViews();
        views.total = (views.total || 0) + 1;
        if (viewerId && typeof viewerId === 'string' && viewerId.length > 0) {
            if (!views.viewers[viewerId]) {
                views.viewers[viewerId] = new Date().toISOString();
            }
        }
        saveViews(views);
        res.json({ success: true });
    } catch (err) {
        console.error('Ошибка сохранения статистики:', err);
        res.status(500).json({ error: 'Ошибка сохранения статистики' });
    }
});

app.get('/api/stats', (req, res) => {
    const key = req.query.key;
    if (key !== STATS_KEY) {
        return res.status(403).json({ error: 'Доступ запрещён. Укажите ?key=...' });
    }
    const views = loadViews();
    res.json({
        total: views.total,
        unique: Object.keys(views.viewers || {}).length,
        lastUpdated: views.lastUpdated
    });
});

// CSV-экспорт статистики
app.get('/api/stats/csv', (req, res) => {
    const key = req.query.key;
    if (key !== STATS_KEY) {
        return res.status(403).json({ error: 'Доступ запрещён. Укажите ?key=...' });
    }
    const views = loadViews();
    const unique = Object.keys(views.viewers || {}).length;

    let csv = '\uFEFF';
    csv += 'metric,value\n';
    csv += `total,${views.total}\n`;
    csv += `unique,${unique}\n`;
    csv += `last_updated,${views.lastUpdated || ''}\n`;
    csv += '\n';
    csv += 'viewer_id,first_seen\n';
    Object.entries(views.viewers || {}).forEach(([id, ts]) => {
        csv += `${id},${ts}\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="series_stats.csv"');
    res.send(csv);
});

// =============================================
//  API: ПРОГРЕСС ЗРИТЕЛЯ
// =============================================
app.post('/api/state/save', (req, res) => {
    const { viewerId, state } = req.body;
    if (!viewerId || typeof viewerId !== 'string') {
        return res.status(400).json({ error: 'Не указан viewerId' });
    }
    if (!state || typeof state !== 'object') {
        return res.status(400).json({ error: 'Не указан state' });
    }
    try {
        const states = loadStates();
        if (Object.keys(state).length === 0) {
            delete states[viewerId];
        } else {
            states[viewerId] = { ...state, updatedAt: new Date().toISOString() };
        }
        saveStates(states);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сохранения' });
    }
});

app.get('/api/state/:viewerId', (req, res) => {
    try {
        const states = loadStates();
        const state = states[req.params.viewerId];
        if (!state) return res.status(404).json({ error: 'Не найдено' });
        res.json(state);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка чтения' });
    }
});

// =============================================
//  API: СЕРИАЛ
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
            id: series.id,
            title: series.title,
            year: series.year || null,
            description: series.description,
            age_rating: series.age_rating,
            genres: series.genres || [],
            trailer: series.trailer || '',
            info: series.info || {},
            episodes
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка чтения сериала: ' + err.message });
    }
});

app.get('/api/episodes', (req, res) => {
    try {
        const series = loadSeries();
        res.json(series.episodes.map(ep => ({
            id: ep.id,
            episode_number: ep.episode_number,
            title: ep.title,
            cover: ep.cover || ''
        })));
    } catch (err) {
        console.error(err);
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
        console.error(err);
        res.status(500).json({ error: 'Ошибка чтения сериала' });
    }
});

app.get('/api/scene/:id', (req, res) => {
    try {
        const series = loadSeries();
        const sceneId = req.params.id;
        let foundScene = null;
        let foundEpisode = null;
        for (const ep of series.episodes) {
            const s = (ep.scenes || []).find(s => s.id === sceneId);
            if (s) {
                foundScene = s;
                foundEpisode = ep;
                break;
            }
        }
        if (!foundScene) return res.status(404).json({ error: 'Сцена не найдена' });
        res.json({
            ...foundScene,
            episode_id: foundEpisode.id,
            episode_number: foundEpisode.episode_number
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка чтения сериала' });
    }
});

// Заглушки для админки
app.post('/api/admin/series', upload.single('cover'), (req, res) => res.json({ message: 'ok' }));
app.post('/api/admin/episode', (req, res) => res.json({ message: 'ok' }));
app.post('/api/admin/glava', upload.single('video'), (req, res) => res.json({ message: 'ok' }));
app.post('/api/admin/transition', (req, res) => res.json({ message: 'ok' }));
app.post('/api/admin/publish', (req, res) => res.json({ message: 'ok' }));

// =============================================
//  API: ПУБЛИЧНАЯ СТАТИСТИКА (для счётчика зрителей на главной)
// =============================================
app.get('/api/stats/public', (req, res) => {
    try {
        const views = loadViews();
        const unique = Object.keys(views.viewers || {}).length;
        // Отдаём только число уникальных зрителей и общее
        res.json({
            unique,
            total: views.total || 0
        });
    } catch (err) {
        res.json({ unique: 0, total: 0 });
    }
});

// =============================================
//  ПРОКСИ ДЛЯ ТРЕЙЛЕРА ИЗ GITHUB RELEASES
//  Принудительно ставит Content-Type: video/mp4,
//  чтобы браузер воспроизводил, а не скачивал.
// =============================================
const { Readable } = require('stream');

const GITHUB_TRAILER_URL = 'https://github.com/breakskyprod/za_kray/releases/download/videos/trailer.mp4';

app.get('/trailer-proxy.mp4', async (req, res) => {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;

    try {
        const response = await fetch(GITHUB_TRAILER_URL, { headers, redirect: 'follow' });

        if (!response.ok && response.status !== 206) {
            console.warn(`[trailer-proxy] GitHub вернул ${response.status}`);
            return res.status(404).end();
        }

        res.status(response.status);

        // 🔑 ГЛАВНОЕ: принудительно ставим video/mp4
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Range');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

        const contentLength = response.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);

        const contentRange = response.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);

        if (response.body) {
            Readable.fromWeb(response.body).pipe(res);
        } else {
            res.end();
        }
    } catch (err) {
        console.error('[trailer-proxy] Ошибка:', err.message);
        res.status(500).end();
    }
});

// =============================================
//  ЗАПУСК
// =============================================
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📁 Данные:      ${DATA_FILE}`);
    console.log(`📊 Статистика:  ${VIEWS_FILE}`);
    console.log(`👥 Прогресс:    ${STATES_FILE}`);
});
