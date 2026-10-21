require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// =============================================
//  СТАТИКА (Фронтенд и Видео)
// =============================================
// Раздаем фронтенд
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Раздаем видео напрямую с сервера
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    maxAge: '1y',
    immutable: true,
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
    }
}));

// =============================================
//  СЕРИАЛ (JSON)
// =============================================
const SERIES_FILE_NAME = process.env.SERIES_FILE || 'series_v2.json';
const DATA_FILE = path.join(__dirname, 'data', SERIES_FILE_NAME);

function loadSeries() {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
}

console.log(`📖 Сериал: ${SERIES_FILE_NAME}`);

// =============================================
//  СТАТИСТИКА И ПРОГРЕСС
// =============================================
const VIEWS_FILE = path.join(__dirname, 'data', 'views.json');
const STATES_FILE = path.join(__dirname, 'data', 'states.json');
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

function loadStates() {
    try {
        return JSON.parse(fs.readFileSync(STATES_FILE, 'utf8'));
    } catch (e) { return {}; }
}

function saveStates(data) {
    fs.writeFileSync(STATES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// API: Статистика
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
        res.status(500).json({ error: 'Ошибка сохранения статистики' });
    }
});

app.get('/api/stats', (req, res) => {
    if (req.query.key !== STATS_KEY) {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    const views = loadViews();
    res.json({ total: views.total, unique: Object.keys(views.viewers || {}).length, lastUpdated: views.lastUpdated });
});

app.get('/api/stats/public', (req, res) => {
    try {
        const views = loadViews();
        res.json({ unique: Object.keys(views.viewers || {}).length, total: views.total || 0 });
    } catch (err) {
        res.json({ unique: 0, total: 0 });
    }
});

// API: Прогресс зрителя
app.post('/api/state/save', (req, res) => {
    const { viewerId, state } = req.body;
    if (!viewerId || !state) return res.status(400).json({ error: 'Неверные данные' });
    try {
        const states = loadStates();
        if (Object.keys(state).length === 0) delete states[viewerId];
        else states[viewerId] = { ...state, updatedAt: new Date().toISOString() };
        saveStates(states);
        res.json({ success: true });
    } catch (err) {
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
});
