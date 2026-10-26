// ============================================================
//  ЗА КРАЙ — доступ к закрытым страницам (пароль на сериал)
//
//  Подключение в server/app.js (ДО express.static и ПОСЛЕ bodyParser):
//      const { accessGate } = require('./access');
//      accessGate(app, { catalogFile: path.join(__dirname, 'data', 'catalog.json') });
//
//  Переменные окружения (server/.env):
//      SERIES_PASSWORD  — пароль на сериал (обязателен, пока сериал закрыт)
//      ACCESS_SECRET    — секрет подписи cookie (>= 32 символов, стабильный)
//      TRUST_PROXY=1    — если за Nginx (нужно для корректного IP)
// ============================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE_NAME = 'zk_access';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 дней
const SERIES_HREF = '/series.html';
// Страницы, которые закрыты паролем, пока сериал заблокирован
const GATED_PAGES = ['/series.html', '/player_v2.html'];

const MAX_FAILS = 5;                 // неверных попыток до блокировки
const LOCK_WINDOW_MS = 15 * 60 * 1000; // блокировка на 15 минут

// Секрет подписи: если не задан — генерируем на старте (cookie сбросятся при рестарте)
let SECRET = process.env.ACCESS_SECRET || '';
if (SECRET.length < 32) {
    if (process.env.ACCESS_SECRET) {
        console.warn('⚠️  ACCESS_SECRET короче 32 символов — используем сгенерированный на старте.');
    } else {
        console.warn('⚠️  ACCESS_SECRET не задан — сессии сбросятся при каждом перезапуске.');
    }
    SECRET = crypto.randomBytes(32).toString('hex');
}

const PASSWORD = process.env.SERIES_PASSWORD || '';
if (!PASSWORD) {
    console.warn('⚠️  SERIES_PASSWORD не задан — доступ к закрытым страницам будет закрыт для всех.');
}

// ---------- Каталог: закрыт ли сериал ----------
function isSeriesLocked(catalogFile) {
    try {
        const data = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
        const item = (data.items || []).find(it => it.href === SERIES_HREF);
        // если записи нет или она не читается — по умолчанию закрыто
        return item ? !!item.locked : true;
    } catch (e) {
        return true;
    }
}

// ---------- Подпись токена: "<expires>.<hmac>" ----------
function sign(payload) {
    return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function makeToken() {
    const expires = Date.now() + COOKIE_MAX_AGE_SEC * 1000;
    const payload = String(expires);
    return payload + '.' + sign(payload);
}

function checkToken(token) {
    if (typeof token !== 'string') return false;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = sign(payload);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const expires = Number(payload);
    return Number.isFinite(expires) && Date.now() < expires;
}

// ---------- Разбор cookie без зависимостей ----------
function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); }
            catch (e) { return null; }
        }
    }
    return null;
}

// ---------- Сравнение пароля без утечки по времени ----------
function passwordMatches(input) {
    if (!PASSWORD || typeof input !== 'string') return false;
    // сравниваем хэши одинаковой длины
    const a = crypto.createHash('sha256').update(input).digest();
    const b = crypto.createHash('sha256').update(PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
}

// ---------- Счётчик неудачных попыток (по IP) ----------
const failures = new Map(); // ip -> { count, lockedUntil }

function clientIp(req) {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

function isLocked(ip) {
    const rec = failures.get(ip);
    if (!rec || !rec.lockedUntil) return false;
    if (Date.now() >= rec.lockedUntil) { failures.delete(ip); return false; }
    return true;
}

function registerFail(ip) {
    const rec = failures.get(ip) || { count: 0, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= MAX_FAILS) {
        rec.lockedUntil = Date.now() + LOCK_WINDOW_MS;
        rec.count = 0;
    }
    failures.set(ip, rec);
}

// ============================================================
//  ПУБЛИЧНАЯ ФУНКЦИЯ: подключить доступ к приложению
// ============================================================
function accessGate(app, options) {
    const catalogFile = options.catalogFile;

    // POST /api/access — проверка пароля
    app.post('/api/access', (req, res) => {
        // отказываем, если пароль не настроен
        if (!PASSWORD) {
            return res.status(503).json({ error: 'Доступ временно недоступен' });
        }
        const ip = clientIp(req);
        if (isLocked(ip)) {
            return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
        }

        const password = req.body && req.body.password;
        // отсекаем заведомо длинный ввод
        if (typeof password !== 'string' || password.length === 0 || password.length > 200) {
            return res.status(400).json({ error: 'Неверный запрос' });
        }

        if (!passwordMatches(password)) {
            registerFail(ip);
            return res.status(401).json({ error: 'Неверный пароль' });
        }

        failures.delete(ip);
        const token = makeToken();
        res.cookie(COOKIE_NAME, token, cookieOpts(req));
        return res.json({ ok: true });
    });

    // Middleware: закрытые страницы
    app.use((req, res, next) => {
        const pathname = req.path;
        if (!GATED_PAGES.includes(pathname)) return next();
        if (!isSeriesLocked(catalogFile)) return next(); // сериал открыт — пускаем всех

        if (checkToken(readCookie(req, COOKIE_NAME))) return next();

        // Нет доступа — отправляем на главную с открытым окном пароля
        const next_ = encodeURIComponent(pathname + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
        return res.redirect(302, `/?gate=1&next=${next_}`);
    });
}

function cookieOpts(req) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE_SEC * 1000,
        path: '/',
        secure: isSecureRequest(req)
    };
}

function isSecureRequest(req) {
    return req.secure || req.get('x-forwarded-proto') === 'https';
}

module.exports = { accessGate, isSeriesLocked, GATED_PAGES, COOKIE_NAME };
