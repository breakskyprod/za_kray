// ==========================================
//  ПРЕЛОАДЕР
// ==========================================
function initPreloader() {
    const preloader = document.getElementById('preloader');
    if (!preloader) return;
    try {
        if (sessionStorage.getItem('intro_shown')) {
            preloader.classList.add('hidden');
            return;
        }
    } catch (e) {}
    setTimeout(() => {
        preloader.classList.add('hidden');
        try { sessionStorage.setItem('intro_shown', '1'); } catch (e) {}
    }, 3200);
}

// ==========================================
//  ПРОГРЕСС ИЗ LOCALSTORAGE
// ==========================================
function getStoryData() {
    try {
        const raw = localStorage.getItem('story_data');
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

// ==========================================
//  ПОДЕЛИТЬСЯ
// ==========================================
function showSharePopup({ url }) {
    const old = document.getElementById('sharePopup');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'sharePopup';
    overlay.className = 'share-popup-overlay';
    overlay.innerHTML = `
        <div class="share-popup">
            <button class="share-popup-close" aria-label="Закрыть">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <line x1="6" y1="6" x2="18" y2="18"/>
                    <line x1="18" y1="6" x2="6" y2="18"/>
                </svg>
            </button>
            <div class="share-popup-badge">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="18" cy="5" r="3"/>
                    <circle cx="6" cy="12" r="3"/>
                    <circle cx="18" cy="19" r="3"/>
                    <line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/>
                    <line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/>
                </svg>
            </div>
            <h3 class="share-popup-title">Поделиться</h3>
            <p class="share-popup-sub">Отправьте другу ссылку на сериал</p>
            <div class="share-popup-field">
                <input type="text" id="sharePopupInput" class="share-popup-input" value="${url}" readonly spellcheck="false">
                <button class="share-popup-copy-inline" id="sharePopupCopy" aria-label="Скопировать">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2.5"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.share-popup-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const input = overlay.querySelector('#sharePopupInput');
    input.addEventListener('focus', () => input.select());
    input.addEventListener('click', () => input.select());
    const copyBtn = overlay.querySelector('#sharePopupCopy');
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(url);
        } catch (e) {
            input.select(); document.execCommand('copy');
        }
        copyBtn.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)';
        setTimeout(close, 800);
    });
    setTimeout(() => { input.focus(); input.select(); }, 80);
}

// ==========================================
//  ЗАГРУЗКА ТРЕЙЛЕРА
// ==========================================
function initTrailer(src) {
    const video = document.getElementById('trailerVideo');
    const soundBtn = document.getElementById('soundToggle');
    if (!video || !src) return;

    video.src = src;
    video.muted = true; // стартуем без звука
    video.loop = true;

    // Автоплей
    const tryPlay = () => {
        const p = video.play();
        if (p && p.catch) {
            p.catch(err => {
                if (err.name !== 'AbortError') {
                    console.warn('Автоплей трейлера заблокирован:', err);
                }
            });
        }
    };
    tryPlay();

    // Кнопка звука
    if (soundBtn) {
        soundBtn.classList.remove('unmuted');
        soundBtn.addEventListener('click', () => {
            video.muted = !video.muted;
            if (video.muted) {
                soundBtn.classList.remove('unmuted');
                soundBtn.title = 'Включить звук';
            } else {
                soundBtn.classList.add('unmuted');
                soundBtn.title = 'Выключить звук';
            }
        });
    }
}

// ==========================================
//  ЗАПОЛНЕНИЕ ИНФО О СЕРИАЛЕ
// ==========================================
function fillInfo(info) {
    if (!info) return;
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el && val != null && val !== '') el.textContent = val;
    };
    set('infoYear', info.year);
    set('infoCountry', info.country);
    set('infoGenres', Array.isArray(info.genres) ? info.genres.join(', ') : info.genres);
    set('infoTagline', info.tagline || '—');
    set('infoDirector', info.director);
    set('infoWriter', info.writer);
    set('infoProducer', info.producer);
    set('infoOperator', info.operator);
    set('infoComposer', info.composer);
    set('infoArtist', info.artist);
    set('infoEditor', info.editor);
    set('infoBoxOffice', info.boxOffice);
    set('infoPremiere', info.premiere);
    set('infoDigital', info.digital);
    set('infoAge', info.age);
    set('infoDuration', info.duration);
}

// ==========================================
//  ЗАГРУЗКА СТАТИСТИКИ ЗРИТЕЛЕЙ
// ==========================================
async function loadViewersCount() {
    const el = document.getElementById('infoViewers');
    if (!el) return;
    try {
        const res = await fetch('/api/stats/public');
        if (!res.ok) return;
        const data = await res.json();
        if (data && typeof data.unique === 'number') {
            // Форматируем: 938 500 → "938,5 тыс."
            const n = data.unique;
            if (n >= 1000) {
                el.textContent = (n / 1000).toFixed(1).replace('.', ',') + ' тыс.';
            } else {
                el.textContent = String(n);
            }
        }
    } catch (e) {}
}

// ==========================================
//  ОСНОВНАЯ ЛОГИКА
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    initPreloader();

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reset') === '1') {
        let viewerId = null;
        try { viewerId = localStorage.getItem('viewer_id'); } catch (e) {}
        try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
        if (viewerId) {
            fetch('/api/state/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ viewerId, state: {} })
            }).finally(() => { window.location.href = window.location.pathname; });
        } else {
            window.location.href = window.location.pathname;
        }
        return;
    }

    try {
        const response = await fetch('/api/series');
        if (!response.ok) throw new Error('Не удалось загрузить сериал');
        const series = await response.json();

        // Заголовок, ценз, жанры, год
        const titleText = document.getElementById('heroTitleText');
        if (titleText) titleText.textContent = series.title || 'За край';
        const metaYear = document.getElementById('metaYear');
        if (metaYear) metaYear.textContent = series.year || '2027';
        const metaGenres = document.getElementById('metaGenres');
        if (metaGenres) metaGenres.textContent = (series.genres || []).join(', ') || 'драма, криминал';
        const metaRating = document.getElementById('metaRating');
        if (metaRating) metaRating.textContent = series.age_rating || '18+';

        // Описание
        const fullDesc = series.description || '';
        const shortDesc = fullDesc.length > 220 ? fullDesc.slice(0, 220).trim() + '…' : fullDesc;
        const shortEl = document.getElementById('shortDescription');
        if (shortEl) shortEl.textContent = shortDesc;

        // Трейлер
        if (series.trailer) {
            initTrailer(series.trailer);
        }

        // Инфо о фильме
        if (series.info) fillInfo(series.info);

        // Счётчик зрителей
        loadViewersCount();

        // Серии
        const episodes = series.episodes || [];
        const carousel = document.getElementById('episodesCarousel');
        carousel.innerHTML = '';

        const storyData = getStoryData();
        const currentEpisodeId = storyData && storyData.episodeId;

        if (episodes.length === 0) {
            carousel.innerHTML = '<p class="loading-text">Нет серий</p>';
        } else {
            episodes.forEach(ep => {
                const card = document.createElement('div');
                card.className = 'episode-card';
                const cover = ep.cover && ep.cover.trim() !== ''
                    ? `/uploads/${ep.cover}`
                    : `/images/frame${ep.episode_number}.jpg`;
                card.style.backgroundImage = `url('${cover}'), linear-gradient(145deg, #1a1a3e, #0b0b1a)`;
                card.innerHTML = `
                    <div class="ep-overlay"></div>
                    <span class="ep-number-badge">${ep.episode_number} серия</span>
                `;
                card.addEventListener('click', () => {
                    window.location.href = `/player_v2.html?episodeId=${ep.id}`;
                });
                carousel.appendChild(card);
            });
        }

        // Кнопка «Смотреть» / «Продолжить»
        const watchBtn = document.getElementById('watchBtn');
        const watchBtnText = document.getElementById('watchBtnText');
        if (storyData && storyData.episodeId) {
            const ep = episodes.find(e => e.id == storyData.episodeId);
            if (ep) watchBtnText.textContent = `Продолжить с серии ${ep.episode_number}`;
        }
        watchBtn.addEventListener('click', () => {
            const data = getStoryData();
            if (data && data.episodeId) {
                window.location.href = `/player_v2.html?episodeId=${data.episodeId}`;
                return;
            }
            if (episodes.length > 0) {
                window.location.href = `/player_v2.html?episodeId=${episodes[0].id}`;
            }
        });

        // Поделиться
        document.getElementById('shareBtn').addEventListener('click', async () => {
            const url = window.location.origin + '/';
            const title = series.title || 'За край';
            const text = 'Смотри интерактивный сериал «За край»';
            const ua = navigator.userAgent || '';
            const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
            if (isMobile && navigator.share) {
                try { await navigator.share({ title, text, url }); return; }
                catch (e) { if (e.name === 'AbortError') return; }
            }
            showSharePopup({ url });
        });

        // Описание «Ещё»
        const descBody = document.getElementById('descBody');
        const toggleBtn = document.getElementById('descToggleBtn');
        let isExpanded = false;
        toggleBtn.addEventListener('click', () => {
            isExpanded = !isExpanded;
            if (isExpanded) {
                descBody.classList.add('expanded');
                descBody.querySelector('p').textContent = fullDesc;
                toggleBtn.textContent = 'Свернуть';
            } else {
                descBody.classList.remove('expanded');
                descBody.querySelector('p').textContent = shortDesc;
                toggleBtn.textContent = 'Ещё';
            }
        });

    } catch (err) {
        console.error(err);
        const t = document.getElementById('heroTitleText');
        if (t) { t.style.display = 'block'; t.textContent = 'Ошибка загрузки'; }
    }
});
