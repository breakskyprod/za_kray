'use strict';
// ============================================================
//  ПРОЕКТЫ-СЕРИИ: проект -> эпизоды -> связи (граф).
//  Связи хранятся внутри эпизодов (кнопки A / Б, таймер, переход),
//  поэтому они не могут разойтись между собой.
//  Файл: data/series_projects.json (фрагменты в projects.json не трогаем).
//  Подключается из admin.js: mountProjects(api, ctx)
// ============================================================
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');

const ID_RE = /^[a-f0-9]{16}$/;
const MAX_TITLE = 120;
const MAX_EPISODES = 200;
const DEFAULT_WINDOW = 10;
const MAX_WINDOW = 30;
const ZAKRAY_ID = '5a4b7c1d2e3f9a80';   // фиксированный id проекта «За край»
const ROLES = ['normal', 'start', 'end'];

const AREA_A = { x: 10, y: 55, width: 35, height: 22 };
const AREA_B = { x: 55, y: 55, width: 35, height: 22 };

const newId = () => crypto.randomBytes(8).toString('hex');
const cleanTitle = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

function blankEpisode(n, x, y) {
    return {
        id: newId(),
        title: 'Эпизод ' + n,
        role: 'normal',                 // normal | start | end
        fragmentId: null,
        x: Math.round(Number(x) || 0),
        y: Math.round(Number(y) || 0),
        interactive: false,
        next: null,
        choice: {
            start: null,
            duration: DEFAULT_WINDOW,
            A: { text: 'Вариант A', target: null, area: { ...AREA_A } },
            B: { text: 'Вариант B', target: null, area: { ...AREA_B } },
            timeoutTarget: null
        }
    };
}

// Что эпизод ведёт дальше (только актуальный режим)
function targetsOf(ep) {
    const out = ep.interactive
        ? [ep.choice.A.target, ep.choice.B.target, ep.choice.timeoutTarget]
        : [ep.next];
    return out.filter(Boolean);
}

function clearChoiceTargets(ep) {
    ep.choice.A.target = null;
    ep.choice.B.target = null;
    ep.choice.timeoutTarget = null;
}

// Проверка правил, которые должны выполняться ВСЕГДА (можно сохранять черновик)
function checkStructure(project, frags) {
    const errors = [];
    const eps = project.episodes;
    const list = Object.values(eps);

    if (list.filter(e => e.role === 'start').length > 1) {
        errors.push('Может быть только один стартовый эпизод');
    }

    const usedFragments = {};
    for (const ep of list) {
        const name = `«${ep.title}»`;
        const targets = targetsOf(ep);

        for (const t of targets) {
            if (!eps[t]) errors.push(`${name}: связь ведёт в удалённый эпизод`);
            else if (t === ep.id) errors.push(`${name}: эпизод не может вести сам в себя`);
            else if (eps[t].role === 'start') errors.push(`${name}: в стартовый эпизод нельзя вести связь`);
        }
        if (ep.role === 'end' && targets.length) {
            errors.push(`${name}: из конечного эпизода нельзя вести связи`);
        }
        if (ep.fragmentId) {
            if (usedFragments[ep.fragmentId]) errors.push(`${name}: видео уже используется в другом эпизоде`);
            usedFragments[ep.fragmentId] = true;
        }
        if (ep.interactive && ep.fragmentId) {
            const f = frags[ep.fragmentId];
            const c = ep.choice;
            if (f && f.duration && c.start != null && c.start + c.duration > f.duration + 0.01) {
                errors.push(`${name}: окно выбора выходит за длительность видео`);
            }
        }
    }
    return errors;
}

// Проверка перед публикацией: всё должно быть заполнено и связано
function checkPublish(project, frags) {
    const errors = checkStructure(project, frags);
    const eps = project.episodes;
    const list = Object.values(eps);
    if (!list.length) return ['В проекте нет эпизодов'];

    const starts = list.filter(e => e.role === 'start');
    const ends = list.filter(e => e.role === 'end');
    if (starts.length !== 1) errors.push('Нужен ровно один стартовый эпизод');
    if (!ends.length) errors.push('Нужен хотя бы один конечный эпизод');

    for (const ep of list) {
        const name = `«${ep.title}»`;
        if (!ep.title || !ep.title.trim()) errors.push('Есть эпизод без названия');
        const f = ep.fragmentId && frags[ep.fragmentId];
        if (!f) { errors.push(`${name}: не загружено видео`); continue; }
        if (ep.role === 'end') continue;

        if (ep.interactive) {
            const c = ep.choice;
            if (!c.A.text.trim()) errors.push(`${name}: пустой текст кнопки A`);
            if (!c.B.text.trim()) errors.push(`${name}: пустой текст кнопки Б`);
            if (!c.A.target) errors.push(`${name}: не задана кнопка A`);
            if (!c.B.target) errors.push(`${name}: не задана кнопка Б`);
            if (!c.timeoutTarget) errors.push(`${name}: не задан таймер`);
            if (c.start == null) errors.push(`${name}: не задано окно выбора`);
        } else if (!ep.next) {
            errors.push(`${name}: не задан переход дальше`);
        }
    }

    // Граф: от старта должно быть достижимо всё, и из всего должен быть путь до конца
    if (starts.length === 1 && !errors.length) {
        const byId = Object.fromEntries(list.map(e => [e.id, e]));
        const seen = new Set([starts[0].id]);
        const q = [starts[0].id];
        while (q.length) {
            const cur = q.shift();
            for (const t of targetsOf(byId[cur])) {
                if (!seen.has(t)) { seen.add(t); q.push(t); }
            }
        }
        list.forEach(e => { if (!seen.has(e.id)) errors.push(`«${e.title}»: до него нельзя дойти от стартового`); });

        const rev = {};
        list.forEach(e => targetsOf(e).forEach(t => { (rev[t] = rev[t] || []).push(e.id); }));
        const toEnd = new Set(ends.map(e => e.id));
        const q2 = [...toEnd];
        while (q2.length) {
            const cur = q2.shift();
            for (const s of rev[cur] || []) {
                if (!toEnd.has(s)) { toEnd.add(s); q2.push(s); }
            }
        }
        list.forEach(e => { if (!toEnd.has(e.id)) errors.push(`«${e.title}»: из него нельзя дойти до конечного`); });
    }
    return errors;
}

// Порядок сцен для плеера: старт первым, концовки последними
const rankRole = (r) => (r === 'start' ? 0 : r === 'end' ? 2 : 1);

// Перевод опубликованного проекта в формат плеера (series_v2)
function buildPlayerSeries(p, frags) {
    const list = Object.values(p.episodes);
    const sid = (id) => 'ep_' + id;

    const ordered = [...list].sort((a, b) => rankRole(a.role) - rankRole(b.role));

    const scenes = ordered.map(ep => {
        const f = frags[ep.fragmentId] || {};
        const c = ep.choice;
        // базовое имя без _720: getVideoUrl в плеере сам добавит качество
        const video = ep.fragmentId ? `clips/${ep.fragmentId}.mp4` : '';

        const choices = ep.interactive ? ['A', 'B'].map(k => ({
            id: k,
            label: c[k].text,
            area: { ...c[k].area, time_start: c.start },
            next: c[k].target ? sid(c[k].target) : null
        })) : [];

        return {
            id: sid(ep.id),
            type: ep.role === 'start' ? 'start' : 'ordinary',
            video,
            choice_timeout: c.duration || DEFAULT_WINDOW,
            choices,
            no_choice: ep.interactive && c.timeoutTarget ? { next: sid(c.timeoutTarget) } : {},
            next: !ep.interactive && ep.next ? sid(ep.next) : null
        };
    });

    return {
        id: p.id,
        title: p.title,
        description: p.description || '',
        age_rating: '',
        genres: [],
        info: {},
        episodes: [{ id: 1, episode_number: 1, title: p.title, cover: '', scenes }]
    };
}

// Применяет часть окна выбора и кнопок. Возвращает текст ошибки или null.
function applyChoice(ep, src) {
    const c = ep.choice;
    if (src.start !== undefined) {
        if (src.start === null) c.start = null;
        else {
            const n = Number(src.start);
            if (!Number.isFinite(n) || n < 0) return 'Начало окна выбора: не меньше 0';
            c.start = Math.round(n * 10) / 10;
        }
    }
    if (src.duration !== undefined) {
        const d = Math.round(Number(src.duration));
        if (!(d >= 1 && d <= MAX_WINDOW)) return `Окно выбора: от 1 до ${MAX_WINDOW} секунд`;
        c.duration = d;
    }
    if (src.timeoutTarget !== undefined) c.timeoutTarget = src.timeoutTarget || null;
    for (const k of ['A', 'B']) {
        const s = src[k];
        if (!s || typeof s !== 'object') continue;
        if (typeof s.text === 'string') c[k].text = s.text.slice(0, 60);
        if (s.target !== undefined) c[k].target = s.target || null;
        if (s.area && typeof s.area === 'object') {
            c[k].area = {
                x: clampPct(s.area.x), y: clampPct(s.area.y),
                width: clampPct(s.area.width), height: clampPct(s.area.height)
            };
        }
    }
    return null;
}

function summary(p) {
    return {
        id: p.id,
        title: p.title,
        kind: p.kind,
        published: !!p.published,
        seriesId: p.seriesId || null,
        episodeNumber: p.episodeNumber || null,
        episodeCount: Object.keys(p.episodes || {}).length,
        updatedAt: p.updatedAt
    };
}

const MAX_SERIES_EPISODES = 4;

// Опубликованные серии сериала по порядку номеров
function publishedEpisodes(store, seriesId) {
    return Object.values(store.projects || {})
        .filter(p => p.published && p.seriesId === seriesId && p.episodeNumber)
        .sort((a, b) => a.episodeNumber - b.episodeNumber);
}

// Проверка привязки к сериалу: номер уникален внутри сериала
function checkSeriesLink(store, p, seriesId, episodeNumber) {
    if (seriesId === null) return null;
    if (seriesId !== ZAKRAY_ID) return 'Неизвестный сериал';
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > MAX_SERIES_EPISODES) {
        return `Номер серии: от 1 до ${MAX_SERIES_EPISODES}`;
    }
    const clash = Object.values(store.projects).find(o =>
        o.id !== p.id && o.seriesId === seriesId && o.episodeNumber === episodeNumber);
    if (clash) return `Серия ${episodeNumber} уже занята проектом «${clash.title}»`;
    return null;
}

// ============================================================
function mountProjects(api, ctx) {
    const { dataDir, serialize, readJson, writeJsonAtomic, loadFragments, enqueueTranscode } = ctx;
    const file = path.join(dataDir, 'series_projects.json');
    // обложки серий: uploads/covers, раздаются через /uploads
    const coversDir = path.join(ctx.uploadsDir || path.join(__dirname, 'uploads'), 'covers');
    const load = () => readJson(file, { projects: {} });
    const save = (store) => writeJsonAtomic(file, store);

    // Карточка опубликованного проекта на главной (catalog.json).
    // Сериал «За край» сюда не попадает: его карточка ведёт на страницу сериала и настраивается отдельно.
    // Остальные проекты открывают плеер сразу, без значка «Сериал».
    function syncCatalog(p) {
        const cf = path.join(dataDir, 'catalog.json');
        let data = { items: [] };
        try { data = readJson(cf, { items: [] }) || { items: [] }; } catch (e) {}
        if (!Array.isArray(data.items)) data.items = [];
        const id = 'project-' + p.id;
        data.items = data.items.filter(it => it.id !== id);
        if (p.published && p.id !== ZAKRAY_ID && !p.seriesId) {
            data.items.push({
                id,
                type: 'project',
                title: p.title,
                poster: p.cover || '',
                locked: false,
                href: '/player_v2.html?p=' + p.id,
                badge: ''
            });
        }
        writeJsonAtomic(cf, data);
    }

    // «За край» создаём сразу, если его ещё нет
    serialize(() => {
        const s = load();
        if (!s.projects[ZAKRAY_ID]) {
            const now = new Date().toISOString();
            s.projects[ZAKRAY_ID] = {
                id: ZAKRAY_ID, title: 'За край', kind: 'series', published: false,
                episodes: {}, createdAt: now, updatedAt: now
            };
            save(s);
        }
    }).catch(() => {});

    const bad = (res) => res.status(400).json({ error: 'Неверный id' });

    // ---- проекты ----
    api.get('/projects', (req, res) => {
        const items = Object.values(load().projects)
            .map(summary)
            .sort((a, b) => (a.id === ZAKRAY_ID ? -1 : b.id === ZAKRAY_ID ? 1 : (a.updatedAt < b.updatedAt ? 1 : -1)));
        res.json({ items });
    });

    api.post('/projects', (req, res) => {
        const title = cleanTitle(req.body && req.body.title);
        if (!title) return res.status(400).json({ error: 'Введите название проекта' });
        serialize(() => {
            const s = load();
            const id = newId();
            const now = new Date().toISOString();
            s.projects[id] = { id, title, kind: 'series', published: false, episodes: {}, createdAt: now, updatedAt: now };
            save(s);
            res.json(s.projects[id]);
        }).catch(() => res.status(500).json({ error: 'Ошибка сохранения' }));
    });

    api.get('/projects/:pid', (req, res) => {
        if (!ID_RE.test(req.params.pid)) return bad(res);
        const p = load().projects[req.params.pid];
        if (!p) return res.status(404).json({ error: 'Проект не найден' });
        const frags = loadFragments();
        const fragments = {};
        Object.values(p.episodes).forEach(ep => {
            const f = ep.fragmentId && frags[ep.fragmentId];
            if (f) fragments[ep.fragmentId] = { status: f.status, duration: f.duration, error: f.error };
        });
        res.json({ ...p, fragments, problems: checkPublish(p, frags) });
    });

    api.patch('/projects/:pid', (req, res) => {
        if (!ID_RE.test(req.params.pid)) return bad(res);
        const title = cleanTitle(req.body && req.body.title);
        if (!title) return res.status(400).json({ error: 'Введите название проекта' });
        serialize(() => {
            const s = load();
            const p = s.projects[req.params.pid];
            if (!p) return res.status(404).json({ error: 'Проект не найден' });
            p.title = title;
            p.updatedAt = new Date().toISOString();
            save(s);
            syncCatalog(p);
            res.json(p);
        }).catch(() => res.status(500).json({ error: 'Ошибка сохранения' }));
    });

    api.delete('/projects/:pid', (req, res) => {
        if (!ID_RE.test(req.params.pid)) return bad(res);
        if (req.params.pid === ZAKRAY_ID) return res.status(400).json({ error: 'Проект «За край» нельзя удалить' });
        serialize(() => {
            const s = load();
            const p = s.projects[req.params.pid];
            if (!p) return res.status(404).json({ error: 'Проект не найден' });
            if (p.published) return res.status(400).json({ error: 'Сначала снимите проект с публикации' });
            delete s.projects[req.params.pid];
            save(s);
            res.json({ ok: true });
        }).catch(() => res.status(500).json({ error: 'Ошибка' }));
    });

    // ---- эпизоды ----
    api.post('/projects/:pid/episodes', (req, res) => {
        if (!ID_RE.test(req.params.pid)) return bad(res);
        const b = req.body || {};
        serialize(() => {
            const s = load();
            const p = s.projects[req.params.pid];
            if (!p) return res.status(404).json({ error: 'Проект не найден' });
            const n = Object.keys(p.episodes).length;
            if (n >= MAX_EPISODES) return res.status(400).json({ error: `Не больше ${MAX_EPISODES} эпизодов` });
            const ep = blankEpisode(n + 1, b.x, b.y);
            p.episodes[ep.id] = ep;
            p.updatedAt = new Date().toISOString();
            save(s);
            res.json(ep);
        }).catch(() => res.status(500).json({ error: 'Ошибка сохранения' }));
    });

    api.patch('/projects/:pid/episodes/:eid', (req, res) => {
        if (!ID_RE.test(req.params.pid) || !ID_RE.test(req.params.eid)) return bad(res);
        const b = req.body || {};
        serialize(() => {
            const s = load();
            const p = s.projects[req.params.pid];
            if (!p) return res.status(404).json({ error: 'Проект не найден' });
            const ep = p.episodes[req.params.eid];
            if (!ep) return res.status(404).json({ error: 'Эпизод не найден' });
            const frags = loadFragments();

            if (typeof b.title === 'string') ep.title = cleanTitle(b.title) || ep.title;
            if (typeof b.x === 'number') ep.x = Math.round(b.x);
            if (typeof b.y === 'number') ep.y = Math.round(b.y);

            if (b.role !== undefined) {
                if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'Неверная роль' });
                ep.role = b.role;
            }
            if (b.fragmentId !== undefined) {
                if (b.fragmentId === null) ep.fragmentId = null;
                else if (typeof b.fragmentId === 'string' && frags[b.fragmentId]) ep.fragmentId = b.fragmentId;
                else return res.status(400).json({ error: 'Видео не найдено' });
            }
            if (typeof b.interactive === 'boolean') {
                ep.interactive = b.interactive;
                if (b.interactive) ep.next = null; else clearChoiceTargets(ep);
            }
            if (b.next !== undefined) ep.next = typeof b.next === 'string' ? b.next : null;
            if (b.choice && typeof b.choice === 'object') {
                const err = applyChoice(ep, b.choice);
                if (err) return res.status(400).json({ error: err });
            }

            const errors = checkStructure(p, frags);
            if (errors.length) return res.status(400).json({ error: 'Связь нарушает правила графа', details: errors });

            p.updatedAt = new Date().toISOString();
            save(s);
            res.json(ep);
        }).catch(() => res.status(500).json({ error: 'Ошибка сохранения' }));
    });

    api.delete('/projects/:pid/episodes/:eid', (req, res) => {
        if (!ID_RE.test(req.params.pid) || !ID_RE.test(req.params.eid)) return bad(res);
        serialize(() => {
            const s = load();
            const p = s.projects[req.params.pid];
            if (!p) return res.status(404).json({ error: 'Проект не найден' });
            if (!p.episodes[req.params.eid]) return res.status(404).json({ error: 'Эпизод не найден' });
            const gone = req.params.eid;
            delete p.episodes[gone];
            // убираем ссылки на удалённый эпизод
            Object.values(p.episodes).forEach(ep => {
                if (ep.next === gone) ep.next = null;
                if (ep.choice.A.target === gone) ep.choice.A.target = null;
                if (ep.choice.B.target === gone) ep.choice.B.target = null;
                if (ep.choice.timeoutTarget === gone) ep.choice.timeoutTarget = null;
            });
            p.updatedAt = new Date().toISOString();
            save(s);
            res.json({ ok: true });
        }).catch(() => res.status(500).json({ error: 'Ошибка' }));
    });

    // ---- обложка (афиша) серии: JPG / PNG / WebP до 5 МБ ----
    api.post('/projects/:pid/cover', express.raw({ type: 'image/*', limit: '5mb' }), (req, res) => {
        if (!ID_RE.test(req.params.pid)) return bad(res);
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Пустой файл' });
        let ext = null;
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) ext = 'jpg';
        else if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) ext = 'png';
        else if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') ext = 'webp';
        if (!ext) return res.status(400).json({ error: 'Нужен файл JPG, PNG или WebP' });
        serialize(() => {
            const s = load();
            const p = s.projects[req.params.pid];
            if (!p) return res.status(404).json({ error: 'Проект не найден' });
            fs.mkdirSync(coversDir, { recursive: true });
            for (const e of ['jpg', 'png', 'webp']) {
                const old = path.join(coversDir, `${p.id}.${e}`);
                if (fs.existsSync(old)) fs.unlinkSync(old);
            }
            fs.writeFileSync(path.join(coversDir, `${p.id}.${ext}`), buf);
            p.cover = `/uploads/covers/${p.id}.${ext}?v=${Date.now()}`;
            p.updatedAt = new Date().toISOString();
            save(s);
            syncCatalog(p);
            res.json({ cover: p.cover });
        }).catch(() => res.status(500).json({ error: 'Ошибка сохранения обложки' }));
    });

    // ---- привязка проекта к сериалу (серия 1–4) ----
    api.patch('/projects/:pid/series', (req, res) => {
        if (!ID_RE.test(req.params.pid)) return bad(res);
        const b = req.body || {};
        const seriesId = (b.seriesId === null || b.seriesId === undefined || b.seriesId === '')
            ? null : String(b.seriesId);
        const episodeNumber = seriesId === null ? null : Number(b.episodeNumber);
        serialize(() => {
            const s = load();
            const p = s.projects[req.params.pid];
            if (!p) return res.status(404).json({ error: 'Проект не найден' });
            if (p.published) return res.status(400).json({ error: 'Сначала снимите проект с публикации' });
            const err = checkSeriesLink(s, p, seriesId, episodeNumber);
            if (err) return res.status(400).json({ error: err });
            p.seriesId = seriesId;
            p.episodeNumber = seriesId === null ? null : episodeNumber;
            p.updatedAt = new Date().toISOString();
            save(s);
            res.json(p);
        }).catch(() => res.status(500).json({ error: 'Ошибка сохранения' }));
    });


    // ---- публикация всей серии ----
    api.post('/projects/:pid/publish', (req, res) => {
        if (!ID_RE.test(req.params.pid)) return bad(res);
        serialize(() => {
            const s = load();
            const p = s.projects[req.params.pid];
            if (!p) return res.status(404).json({ error: 'Проект не найден' });
            const frags = loadFragments();
            const errors = checkPublish(p, frags);
            if (p.seriesId && !p.episodeNumber) errors.push('Не указан номер серии');
            if (errors.length) return res.status(400).json({ error: 'Проект не готов к публикации', details: errors });

            p.published = true;
            p.updatedAt = new Date().toISOString();
            save(s);
            syncCatalog(p);
            // перекодируем все видео серии, которые ещё не готовы
            Object.values(p.episodes).forEach(ep => {
                const f = frags[ep.fragmentId];
                if (f && f.status !== 'ready') enqueueTranscode(ep.fragmentId);
            });
            res.json(p);
        }).catch(() => res.status(500).json({ error: 'Ошибка публикации' }));
    });

    api.post('/projects/:pid/unpublish', (req, res) => {
        if (!ID_RE.test(req.params.pid)) return bad(res);
        serialize(() => {
            const s = load();
            const p = s.projects[req.params.pid];
            if (!p) return res.status(404).json({ error: 'Проект не найден' });
            p.published = false;
            p.updatedAt = new Date().toISOString();
            save(s);
            syncCatalog(p);
            res.json(p);
        }).catch(() => res.status(500).json({ error: 'Ошибка' }));
    });
}

module.exports = { mountProjects, checkStructure, checkPublish, buildPlayerSeries, publishedEpisodes, ZAKRAY_ID };