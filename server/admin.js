'use strict';
// ============================================================
//  АДМИНКА: вход по ADMIN_KEY, загрузка фрагментов по частям,
//  модель интерактива (A / B / таймер), публикация + ffmpeg.
//
//  Подключение в app.js — ПОСЛЕ accessGate, ДО express.static:
//      const { mountAdmin } = require('./admin');
//      mountAdmin(app, {
//          dataDir:    path.join(__dirname, 'data'),
//          uploadsDir: path.join(__dirname, 'uploads'),   // публичная (nginx /uploads/)
//          privateDir: path.join(__dirname, 'private'),   // исходники, НЕ отдаётся наружу
//          frontendDir: path.join(__dirname, '..', 'frontend')
//      });
//
//  Переменные окружения (server/.env):
//      ADMIN_KEY — не короче 24 символов. Без него админка отключена, сайт работает.
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const { mountProjects } = require('./projects');

const MAX_FILE_BYTES = 1024 * 1024 * 1024;   // 1 ГБ
const CHUNK_BYTES = 8 * 1024 * 1024;         // клиент шлёт по 8 МБ
const ALLOWED_EXT = ['.mp4', '.mov'];
const QUALITIES = [720, 480, 360];            // ладдер перекодирования
const DEFAULT_WINDOW = 10;                   // секунд на выбор
const MAX_WINDOW = 30;
const SESSION_COOKIE = 'zk_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const ID_RE = /^[a-f0-9]{16}$/;

const DEFAULT_AREA_A = { x: 10, y: 55, width: 35, height: 22 };
const DEFAULT_AREA_B = { x: 55, y: 55, width: 35, height: 22 };

function newId() { return crypto.randomBytes(8).toString('hex'); }
function sha(s) { return crypto.createHash('sha256').update(s).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }

function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
        }
    }
    return null;
}

// ---------- ffprobe / ffmpeg (без shell, аргументы массивом) ----------
function probeDuration(file) {
    return new Promise((resolve) => {
        execFile(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
            { timeout: 60000 }, (err, stdout, stderr) => {
                if (err) {
                    console.error('[ffprobe] ошибка:', err.code, String(stderr || err.message).slice(-300));
                    return resolve(null);
                }
                const d = parseFloat(stdout);
                if (!Number.isFinite(d) || d <= 0) {
                    console.error('[ffprobe] нет длительности, вывод:', JSON.stringify(stdout));
                }
                resolve(Number.isFinite(d) && d > 0 ? d : null);
            });
    });
}

function runFfmpeg(input, out, height) {
    // VIDEO_ENCODER=cpu в server/.env отключает аппаратное кодирование
    const USE_HW = process.env.VIDEO_ENCODER !== 'cpu';

    const buildArgs = (codec) => {
        const common = [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', input,
            '-vf', `scale=-2:min(ih\\,${height})`,   // не растягиваем маленькие исходники
        ];
        const tail = ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
        if (codec === 'amf') {
            return [...common,
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23',
                '-pix_fmt', 'yuv420p', ...tail];
        }
        return [...common,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
            ...tail];
    };

    return new Promise((resolve, reject) => {
        const run = (codec, onFail) => {
            execFile(process.env.FFMPEG_BIN || 'ffmpeg', buildArgs(codec), { maxBuffer: 10 * 1024 * 1024 }, (err, _so, stderr) => {
                if (!err) return resolve();
                try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (e) {}
                const msg = String(stderr || err.message).slice(-300);
                if (onFail) return onFail(msg);
                reject(new Error('ffmpeg: ' + msg));
            });
        };

        if (USE_HW) {
            run('amf', (hwErr) => {
                console.warn('AMF не сработал, кодируем через libx264:', hwErr.slice(-200));
                run('sw');
            });
        } else {
            run('sw');
        }
    });
}

// ============================================================
function mountAdmin(app, opts) {
    const { dataDir, uploadsDir, privateDir, frontendDir } = opts;
    const ADMIN_KEY = process.env.ADMIN_KEY || '';
    const enabled = ADMIN_KEY.length >= 24;
    if (!enabled) console.warn('⚠️  ADMIN_KEY не задан или короче 24 символов — админка отключена.');

    const sessionKey = sha('admin-session:' + ADMIN_KEY);
    const tmpDir = path.join(privateDir, 'tmp');
    const rawDir = path.join(privateDir, 'raw');
    const clipsDir = path.join(uploadsDir, 'clips');
    const projectsFile = path.join(dataDir, 'projects.json');
    const catalogFile = path.join(dataDir, 'catalog.json');

    [dataDir, tmpDir, rawDir, clipsDir].forEach(d => fs.mkdirSync(d, { recursive: true }));

    // ---------- хранилище: очередь записей + атомарная запись ----------
    let writeChain = Promise.resolve();
    function serialize(task) {
        const next = writeChain.then(task, task);
        writeChain = next.catch(() => {});
        return next;
    }
    function readJson(file, fallback) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
    }
    function writeJsonAtomic(file, obj) {
        const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
        fs.renameSync(tmp, file);
    }
    const loadProjects = () => readJson(projectsFile, { fragments: {} });
    const loadCatalog = () => readJson(catalogFile, { items: [] });

    // ---------- сессия админа (HMAC, ключ производный от ADMIN_KEY) ----------
    function makeSession() {
        const exp = String(Date.now() + SESSION_TTL_MS);
        return exp + '.' + crypto.createHmac('sha256', sessionKey).update(exp).digest('base64url');
    }
    function checkSession(token) {
        if (typeof token !== 'string') return false;
        const i = token.lastIndexOf('.');
        if (i < 1) return false;
        const exp = token.slice(0, i);
        const sig = Buffer.from(token.slice(i + 1));
        const good = Buffer.from(crypto.createHmac('sha256', sessionKey).update(exp).digest('base64url'));
        if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return false;
        return Date.now() < Number(exp);
    }
    function requireAdmin(req, res, next) {
        if (!enabled) return res.status(503).json({ error: 'Админка отключена' });
        if (!checkSession(readCookie(req, SESSION_COOKIE))) return res.status(401).json({ error: 'Нужен вход' });
        next();
    }

    // ---------- страница админки (отдаётся только с no-store, без публичной статики) ----------
    app.get('/admin', (req, res) => {
        if (!enabled) return res.status(503).type('text').send('Админка отключена: задайте ADMIN_KEY');
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(privateDir, 'admin.html'), (err) => {
            if (err && !res.headersSent) res.status(404).send('admin.html не найден');
        });
    });

    // ---------- вход / выход ----------
    const failures = new Map();
    app.post('/api/admin/login', (req, res) => {
        if (!enabled) return res.status(503).json({ error: 'Админка отключена' });
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const rec = failures.get(ip);
        if (rec && rec.lockedUntil > Date.now()) {
            return res.status(429).json({ error: 'Слишком много попыток. Подождите 15 минут.' });
        }
        const key = req.body && req.body.key;
        const ok = typeof key === 'string' && key.length > 0 && key.length <= 200 && safeEqual(key, ADMIN_KEY);
        if (!ok) {
            const r = failures.get(ip) || { count: 0, lockedUntil: 0 };
            r.count += 1;
            if (r.count >= MAX_FAILS) { r.lockedUntil = Date.now() + LOCK_MS; r.count = 0; }
            failures.set(ip, r);
            return res.status(401).json({ error: 'Неверный ключ' });
        }
        failures.delete(ip);
        res.cookie(SESSION_COOKIE, makeSession(), {
            httpOnly: true, sameSite: 'strict', maxAge: SESSION_TTL_MS, path: '/',
            secure: req.secure || req.get('x-forwarded-proto') === 'https'
        });
        res.json({ ok: true });
    });
    app.post('/api/admin/logout', (req, res) => {
        res.clearCookie(SESSION_COOKIE, { path: '/' });
        res.json({ ok: true });
    });

    // ---------- публичный API ролика для плеера ----------
    // Отдаёт только опубликованный и перекодированный фрагмент.
    app.get('/api/clips/:id', (req, res) => {
        if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Неверный id' });
        const frag = loadProjects().fragments[req.params.id];
        if (!frag || !frag.published || frag.status !== 'ready') {
            return res.status(404).json({ error: 'Ролик не найден' });
        }
        const c = frag.choice;
        res.json({
            id: frag.id,
            title: frag.title,
            video: `clips/${frag.id}.mp4`,        // плеер добавит _720 / _480
            interactive: !!frag.interactive,
            pause_at: frag.interactive ? c.start : null,
            choice_timeout: frag.interactive ? c.duration : null,
            choices: frag.interactive ? [
                { id: 'A', label: c.A.text, area: c.A.area, next: c.A.target },
                { id: 'B', label: c.B.text, area: c.B.area, next: c.B.target }
            ] : [],
            no_choice: { next: frag.interactive ? c.timeoutTarget : null },
            next: frag.interactive ? null : frag.next
        });
    });

    // ---------- защищённый API админки ----------
    const api = express.Router();
    api.use(requireAdmin);

    // ---- загрузка по частям ----
    const uploads = new Map(); // uploadId -> { file, ext, title, size, received }

    api.post('/uploads/init', (req, res) => {
        const { filename, size } = req.body || {};
        const ext = path.extname(String(filename || '')).toLowerCase();
        if (!ALLOWED_EXT.includes(ext)) return res.status(400).json({ error: 'Допустимы только MP4 и MOV' });
        const n = Number(size);
        if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'Неверный размер файла' });
        if (n > MAX_FILE_BYTES) return res.status(413).json({ error: 'Файл больше 1 ГБ' });

        const uid = newId();
        const file = path.join(tmpDir, uid + '.part');
        fs.writeFileSync(file, '');
        const title = path.basename(String(filename), ext).replace(/[^\p{L}\p{N}\s._-]/gu, '').trim().slice(0, 120) || 'Без названия';
        uploads.set(uid, { file, ext, title, size: n, received: 0 });
        res.json({ uploadId: uid, chunkSize: CHUNK_BYTES });
    });

    api.put('/uploads/:uid/chunk',
        express.raw({ type: '*/*', limit: CHUNK_BYTES + 1024 }),
        (req, res) => {
            const up = uploads.get(req.params.uid);
            if (!up) return res.status(404).json({ error: 'Загрузка не найдена' });
            const offset = Number(req.query.offset);
            if (offset !== up.received) {
                return res.status(409).json({ error: 'Неверный offset', received: up.received });
            }
            const body = req.body;
            if (!Buffer.isBuffer(body) || body.length === 0 || body.length > CHUNK_BYTES) {
                return res.status(400).json({ error: 'Неверный размер части' });
            }
            if (up.received + body.length > up.size) return res.status(400).json({ error: 'Больше заявленного размера' });
            fs.appendFileSync(up.file, body);
            up.received += body.length;
            res.json({ received: up.received });
        });

    api.post('/uploads/:uid/complete', async (req, res) => {
        const up = uploads.get(req.params.uid);
        if (!up) return res.status(404).json({ error: 'Загрузка не найдена' });
        if (up.received !== up.size) return res.status(409).json({ error: 'Загрузка не завершена', received: up.received });

        // Проверка «магии» контейнера: в MP4/MOV на 4-м байте стоит 'ftyp'
        const head = Buffer.alloc(12);
        const fd = fs.openSync(up.file, 'r');
        fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);
        if (head.slice(4, 8).toString('latin1') !== 'ftyp') {
            fs.unlinkSync(up.file);
            uploads.delete(req.params.uid);
            return res.status(415).json({ error: 'Файл не похож на видео MP4/MOV' });
        }

        const duration = await probeDuration(up.file);
        if (!duration) {
            fs.unlinkSync(up.file);
            uploads.delete(req.params.uid);
            return res.status(422).json({ error: 'Не удалось прочитать видео (проверьте, что установлен ffprobe)' });
        }

        const id = newId();
        const rawFile = id + up.ext;
        fs.renameSync(up.file, path.join(rawDir, rawFile));
        uploads.delete(req.params.uid);

        const now = new Date().toISOString();
        const frag = {
            id, title: up.title, rawFile, duration: Math.round(duration * 100) / 100,
            status: 'uploaded', error: null, published: false, outputs: {},
            interactive: false,
            choice: {
                start: null, duration: DEFAULT_WINDOW,
                A: { text: 'Вариант A', target: null, area: { ...DEFAULT_AREA_A } },
                B: { text: 'Вариант B', target: null, area: { ...DEFAULT_AREA_B } },
                timeoutTarget: null
            },
            next: null, createdAt: now, updatedAt: now
        };
        await serialize(() => {
            const p = loadProjects();
            p.fragments[id] = frag;
            writeJsonAtomic(projectsFile, p);
        });
        // кодирование запускаем сразу после загрузки, не дожидаясь публикации
        enqueueTranscode(id);
        res.json(frag);
    });

    // ---- фрагменты ----
    api.get('/fragments', (req, res) => {
        const list = Object.values(loadProjects().fragments)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        res.json({ items: list });
    });

    api.get('/fragments/:id', (req, res) => {
        if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Неверный id' });
        const frag = loadProjects().fragments[req.params.id];
        if (!frag) return res.status(404).json({ error: 'Не найдено' });
        res.json(frag);
    });

    // Проверка связей и окна выбора. Возвращает массив ошибок.
    function validateFragment(frag, all) {
        const errors = [];
        const exists = (t) => t === null || t === undefined || (typeof t === 'string' && !!all[t]);

        if (!frag.title || !frag.title.trim()) errors.push('Пустое название');

        if (frag.interactive) {
            const c = frag.choice;
            if (!Number.isFinite(c.duration) || c.duration < 1 || c.duration > MAX_WINDOW) {
                errors.push(`Окно выбора: от 1 до ${MAX_WINDOW} секунд`);
            }
            if (!Number.isFinite(c.start) || c.start < 0) {
                errors.push('Не задано начало окна выбора');
            } else if (frag.duration && c.start + c.duration > frag.duration + 0.01) {
                errors.push('Окно выбора не помещается в длительность фрагмента');
            }
            ['A', 'B'].forEach(k => {
                if (!c[k].text || !c[k].text.trim()) errors.push(`Пустой текст кнопки ${k}`);
                if (!exists(c[k].target)) errors.push(`Кнопка ${k}: несуществующий фрагмент`);
            });
            if (!exists(c.timeoutTarget)) errors.push('Таймер: несуществующий фрагмент');
        } else {
            if (!exists(frag.next)) errors.push('Переход: несуществующий фрагмент');
        }
        return errors;
    }

    api.patch('/fragments/:id', (req, res) => {
        if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Неверный id' });
        const body = req.body || {};
        serialize(() => {
            const p = loadProjects();
            const frag = p.fragments[req.params.id];
            if (!frag) return res.status(404).json({ error: 'Не найдено' });

            if (typeof body.title === 'string') frag.title = body.title.slice(0, 120);
            if (typeof body.interactive === 'boolean') frag.interactive = body.interactive;
            if (body.next !== undefined) frag.next = body.next || null;

            if (body.choice && typeof body.choice === 'object') {
                const src = body.choice;
                const c = frag.choice;
                if (src.start !== undefined) c.start = src.start === null ? null : Number(src.start);
                if (src.duration !== undefined) c.duration = Number(src.duration);
                if (src.timeoutTarget !== undefined) c.timeoutTarget = src.timeoutTarget || null;
                ['A', 'B'].forEach(k => {
                    if (!src[k] || typeof src[k] !== 'object') return;
                    if (typeof src[k].text === 'string') c[k].text = src[k].text.slice(0, 60);
                    if (src[k].target !== undefined) c[k].target = src[k].target || null;
                    if (src[k].area && typeof src[k].area === 'object') {
                        const a = src[k].area;
                        c[k].area = {
                            x: Number(a.x), y: Number(a.y), width: Number(a.width), height: Number(a.height)
                        };
                    }
                });
            }

            const errors = validateFragment(frag, p.fragments);
            if (errors.length) return res.status(400).json({ error: 'Проверьте фрагмент', details: errors });

            frag.updatedAt = new Date().toISOString();
            writeJsonAtomic(projectsFile, p);
            res.json(frag);
        }).catch(() => res.status(500).json({ error: 'Ошибка сохранения' }));
    });

    // ---- публикация (ffmpeg запускается автоматически) ----
    api.post('/fragments/:id/publish', (req, res) => {
        if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Неверный id' });
        serialize(() => {
            const p = loadProjects();
            const frag = p.fragments[req.params.id];
            if (!frag) return res.status(404).json({ error: 'Не найдено' });
            const errors = validateFragment(frag, p.fragments);
            if (errors.length) return res.status(400).json({ error: 'Проверьте фрагмент перед публикацией', details: errors });

            frag.published = true;
            frag.updatedAt = new Date().toISOString();
            if (frag.status !== 'ready') frag.status = 'queued';
            writeJsonAtomic(projectsFile, p);
            res.json(frag);
            if (frag.status === 'queued') enqueueTranscode(frag.id);
            else if (frag.status === 'ready') upsertClipInCatalog(frag);
        }).catch(() => res.status(500).json({ error: 'Ошибка публикации' }));
    });

    api.post('/fragments/:id/unpublish', (req, res) => {
        if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Неверный id' });
        serialize(() => {
            const p = loadProjects();
            const frag = p.fragments[req.params.id];
            if (!frag) return res.status(404).json({ error: 'Не найдено' });
            frag.published = false;
            writeJsonAtomic(projectsFile, p);
            removeClipFromCatalog(frag.id);
            res.json(frag);
        }).catch(() => res.status(500).json({ error: 'Ошибка' }));
    });

    // ---- каталог главной ----
    api.get('/catalog', (req, res) => res.json(loadCatalog()));

    api.patch('/catalog/:id', (req, res) => {
        const body = req.body || {};
        serialize(() => {
            const c = loadCatalog();
            const item = c.items.find(i => i.id === req.params.id);
            if (!item) return res.status(404).json({ error: 'Карточка не найдена' });
            if (typeof body.locked === 'boolean') item.locked = body.locked;
            if (typeof body.poster === 'string') {
                if (body.poster.length > 300 || /[\\<>"']/.test(body.poster)) {
                    return res.status(400).json({ error: 'Неверный путь к постеру' });
                }
                item.poster = body.poster;
            }
            if (typeof body.badge === 'string') item.badge = body.badge.slice(0, 40);
            writeJsonAtomic(catalogFile, c);
            res.json(item);
        }).catch(() => res.status(500).json({ error: 'Ошибка сохранения' }));
    });

    // ---- проекты (серии): /api/admin/projects... ----
    mountProjects(api, {
        dataDir,
        uploadsDir,
        serialize,
        readJson,
        writeJsonAtomic,
        loadFragments: () => loadProjects().fragments || {},
        enqueueTranscode
    });

    app.use('/api/admin', api);

    // ============================================================
    //  КАТАЛОГ РОЛИКОВ
    // ============================================================
    function upsertClipInCatalog(frag) {
        return serialize(() => {
            const c = loadCatalog();
            const cid = 'clip-' + frag.id;
            const item = {
                id: cid, type: 'clip', title: frag.title, poster: frag.poster || '',
                locked: false, href: `/player_v2.html?clip=${frag.id}`, badge: 'Ролик'
            };
            const i = c.items.findIndex(x => x.id === cid);
            if (i >= 0) c.items[i] = { ...c.items[i], ...item }; else c.items.push(item);
            writeJsonAtomic(catalogFile, c);
        });
    }
    function removeClipFromCatalog(id) {
        return serialize(() => {
            const c = loadCatalog();
            c.items = c.items.filter(x => x.id !== 'clip-' + id);
            writeJsonAtomic(catalogFile, c);
        });
    }

    // ============================================================
    //  ОЧЕРЕДЬ FFMPEG (по одной задаче за раз)
    // ============================================================
    const jobQueue = [];
    let working = false;

    function enqueueTranscode(id) {
        if (!jobQueue.includes(id)) jobQueue.push(id);
        setImmediate(runQueue);
    }

    async function runQueue() {
        if (working) return;
        working = true;
        try {
            while (jobQueue.length) {
                await transcodeFragment(jobQueue.shift());
            }
        } finally {
            working = false;
        }
    }

    function updateFragment(id, fn) {
        return serialize(() => {
            const p = loadProjects();
            if (!p.fragments[id]) return null;
            fn(p.fragments[id]);
            p.fragments[id].updatedAt = new Date().toISOString();
            writeJsonAtomic(projectsFile, p);
            return p.fragments[id];
        });
    }

    async function transcodeFragment(id) {
        const frag = loadProjects().fragments[id];
        if (!frag) return;
        await updateFragment(id, f => { f.status = 'processing'; f.error = null; });
        try {
            const input = path.join(rawDir, frag.rawFile);
            const outputs = {};
            for (const h of QUALITIES) {
                const name = `${id}_${h}.mp4`;
                await runFfmpeg(input, path.join(clipsDir, name), h);
                outputs[h] = `clips/${name}`;
            }
            const done = await updateFragment(id, f => { f.status = 'ready'; f.outputs = outputs; });
            if (done && done.published) await upsertClipInCatalog(done);
        } catch (e) {
            await updateFragment(id, f => { f.status = 'error'; f.error = String(e.message || e).slice(0, 500); });
        }
    }

    // При старте: задачи, которые не успели завершиться, ставим заново
    const startup = loadProjects();
    let requeued = 0;
    Object.values(startup.fragments).forEach(f => {
        if (f.published && f.status !== 'ready') {
            if (f.status !== 'error') { f.status = 'queued'; requeued++; }
            jobQueue.push(f.id);
        }
    });
    if (requeued || jobQueue.length) {
        serialize(() => writeJsonAtomic(projectsFile, startup));
        setImmediate(runQueue);
    }
    console.log(`🎬 Админка: ${enabled ? 'включена' : 'отключена'}, ffmpeg-очередь: ${jobQueue.length}`);
}

module.exports = { mountAdmin };
