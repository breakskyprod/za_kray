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

// Раздача статики
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Multer – на будущее, если захотите загрузку через веб
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, uuidv4() + ext);
    }
});
const upload = multer({ storage });

// =============================================
//  ЗАГРУЗКА СЕРИАЛА ИЗ JSON-ФАЙЛА
// =============================================
const DATA_FILE = path.join(__dirname, 'data', 'series.json');

function loadSeries() {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
}

// =============================================
//  API ДЛЯ ЗРИТЕЛЬСКОЙ ЧАСТИ
// =============================================

// Шапка сериала + список серий
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
            description: series.description,
            age_rating: series.age_rating,
            genres: series.genres || [],
            episodes
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка чтения series.json: ' + err.message });
    }
});

// Список серий
app.get('/api/episodes', (req, res) => {
    try {
        const series = loadSeries();
        const episodes = series.episodes.map(ep => ({
            id: ep.id,
            episode_number: ep.episode_number,
            title: ep.title,
            cover: ep.cover || ''
        }));
        res.json(episodes);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка чтения series.json' });
    }
});

// Одна серия с главами и переходами
app.get('/api/episode/:id', (req, res) => {
    try {
        const series = loadSeries();
        const ep = series.episodes.find(e => e.id == req.params.id);
        if (!ep) return res.status(404).json({ error: 'Серия не найдена' });
        res.json(ep);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка чтения series.json' });
    }
});

// Одна глава + её переходы (в формате, который ждёт фронт)
app.get('/api/glava/:id', (req, res) => {
    try {
        const series = loadSeries();
        const glavaId = parseInt(req.params.id);

        let foundGlava = null;
        let foundEpisode = null;

        for (const ep of series.episodes) {
            const g = ep.glavas.find(g => g.id === glavaId);
            if (g) {
                foundGlava = g;
                foundEpisode = ep;
                break;
            }
        }

        if (!foundGlava) return res.status(404).json({ error: 'Глава не найдена' });

        const transitions = foundEpisode.transitions
            .filter(t => t.from === glavaId)
            .map(t => ({
                to_glava_id: t.to,
                area_data: JSON.stringify(t.area)
            }));

        res.json({
            id: foundGlava.id,
            title: foundGlava.title,
            video_url: foundGlava.video,
            glava_type: foundGlava.type,
            episode_id: foundEpisode.id,
            transitions
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка чтения series.json' });
    }
});

// Заглушка статистики
app.post('/api/stats/view', (req, res) => res.json({ success: true }));

// =============================================
//  ЗАПУСК
// =============================================
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📁 Данные: ${DATA_FILE}`);
    console.log(`📁 Видео:  ${path.join(__dirname, 'uploads')}`);
});
