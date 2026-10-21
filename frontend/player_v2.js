// ============================================================
//  КОНСТАНТЫ
// ============================================================
const SKIP_BUTTON_DELAY = 10;       // за сколько секунд до конца показывать «Следующая серия»
const PRELOAD_DELAY = 5000;         // через сколько после старта сцены запускать прелоад (мс)

// ============================================================
//  ФИКС ВЫСОТЫ ВЬЮПОРТА (iOS)
// ============================================================
function updateAppHeight() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', h + 'px');
}
updateAppHeight();
window.addEventListener('resize', updateAppHeight);
window.addEventListener('orientationchange', () => setTimeout(updateAppHeight, 150));
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateAppHeight);
    window.visualViewport.addEventListener('scroll', updateAppHeight);
}

// ============================================================
//  БЕЗОПАСНЫЙ PLAY
// ============================================================
function safePlay(el) {
    if (!el) return;
    try {
        const p = el.play();
        if (p && typeof p.catch === 'function') {
            p.catch(err => {
                if (err && err.name !== 'AbortError') {
                    console.warn('play() ошибка:', err);
                }
            });
        }
    } catch (e) {
        console.warn('play() выбросил:', e);
    }
}

// ============================================================
//  VIEWER ID
// ============================================================
function getViewerId() {
    try {
        let id = localStorage.getItem('viewer_id');
        if (!id) {
            id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem('viewer_id', id);
        }
        return id;
    } catch (e) { return null; }
}

// ============================================================
//  STORY STATE
// ============================================================
const initialStoryState = {
    group_contact: false, max_signal: false, max_action: false, max_evidence: false, max_adult: false,
    anya_job: false, anya_money: false, anya_transfer: false, anya_understand: false, anya_adult: false,
    timur_job: false, timur_paid: false, timur_repeat: false, timur_suspicion: false, timur_drug: 0, timur_adult: false,
    lena_alex: false, lena_views: false, lena_validation: false, lena_extrem: false, lena_evidence: false, lena_adult: false
};

let storyState = { ...initialStoryState };
let playedInserts = [];
let watchedEpisodes = [];
let currentEpisodeId = null;
let currentSceneId = null;
let currentScene = null;
let currentEpisodeScenes = [];
let episodesList = [];
let seriesData = null;
let isInsertPlaying = false;

const sceneChoiceState = {
    pauseAt: null, triggered: false, resolved: false,
    timeoutId: null, countdownId: null, timeoutAt: 0, timeoutDuration: 10
};

const STORAGE_KEY = 'zaykrai_progress';

// ============================================================
//  ПРЕДЗАГРУЗКА СЛЕДУЮЩЕЙ СЦЕНЫ
// ============================================================
const preloadedUrls = new Set();

function shouldPreload() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return true;
    const et = conn.effectiveType;
    if (et === 'slow-2g' || et === '2g' || et === '3g') return false;
    return true;
}

function preloadNextScene() {
    const scene = currentScene;
    if (!scene) return;

    let nextSceneId = scene.next || null;
    if (!nextSceneId && scene.choices && scene.choices.length) {
        const firstChoice = scene.choices[0];
        nextSceneId = firstChoice.next || null;
    }
    if (!nextSceneId) return;

    fetch(`/api/scene/${nextSceneId}`)
        .then(r => r.json())
        .then(nextScene => {
            if (!nextScene.video) return;
            const url = `/uploads/${nextScene.video}`;
            if (preloadedUrls.has(url)) return;
            preloadedUrls.add(url);
            console.log(`[preload] Фоновая загрузка: ${url}`);
            fetch(url, { cache: 'force-cache' }).catch(() => {});
        })
        .catch(() => {});
}

// ============================================================
//  СОХРАНЕНИЕ / ЗАГРУЗКА ПРОГРЕССА
// ============================================================
function saveProgress() {
    const data = { episodeId: currentEpisodeId, sceneId: currentSceneId, storyState, playedInserts, watchedEpisodes, savedAt: Date.now() };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
    const viewerId = getViewerId();
    if (viewerId) {
        fetch('/api/state/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewerId, state: data })
        }).catch(() => {});
    }
}

function loadProgress() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

async function loadStoryDataAsync() {
    const local = loadProgress();
    if (local && local.episodeId) return local;
    const viewerId = getViewerId();
    if (!viewerId) return null;
    try {
        const res = await fetch(`/api/state/${viewerId}`);
        if (!res.ok) return null;
        const remote = await res.json();
        if (remote && remote.episodeId) {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(remote)); } catch (e) {}
            return remote;
        }
    } catch (e) {}
    return null;
}

function clearProgress() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    const viewerId = getViewerId();
    if (viewerId) {
        fetch('/api/state/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewerId, state: {} })
        }).catch(() => {});
    }
}

// ============================================================
//  ПАРСЕР УСЛОВИЙ
// ============================================================
function parseCondition(expr) {
    if (!expr || typeof expr !== 'string') return true;
    const tokens = tokenizeCondition(expr);
    let pos = 0;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }

    function parseOr() {
        let left = parseAnd();
        while (peek() && peek().type === 'op' && peek().value === '||') { next(); left = { type: 'or', left, right: parseAnd() }; }
        return left;
    }
    function parseAnd() {
        let left = parseComparison();
        while (peek() && peek().type === 'op' && peek().value === '&&') { next(); left = { type: 'and', left, right: parseComparison() }; }
        return left;
    }
    function parseComparison() {
        let left = parseUnary();
        if (peek() && peek().type === 'op' && (peek().value === '==' || peek().value === '!=')) {
            const op = next().value; return { type: 'compare', op, left, right: parseUnary() };
        }
        return left;
    }
    function parseUnary() {
        if (peek() && peek().type === 'op' && peek().value === '!') { next(); return { type: 'not', value: parseUnary() }; }
        return parseAtom();
    }
    function parseAtom() {
        const t = next();
        if (!t) return { type: 'lit', value: false };
        if (t.type === 'paren') return t.value;
        if (t.type === 'literal') return { type: 'lit', value: t.value };
        if (t.type === 'ident') return { type: 'ident', name: t.value };
        return { type: 'lit', value: false };
    }
    function evaluate(node) {
        switch (node.type) {
            case 'lit': return node.value;
            case 'ident': { const v = storyState[node.name]; return v === undefined ? false : v; }
            case 'not': return !evaluate(node.value);
            case 'and': return evaluate(node.left) && evaluate(node.right);
            case 'or':  return evaluate(node.left) || evaluate(node.right);
            case 'compare': {
                const l = evaluate(node.left), r = evaluate(node.right);
                if (node.op === '==') return l == r;
                if (node.op === '!=') return l != r;
                return false;
            }
        }
        return false;
    }
    return !!evaluate(parseOr());
}

function tokenizeCondition(expr) {
    const tokens = []; let i = 0;
    while (i < expr.length) {
        const c = expr[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '&' && expr[i+1] === '&') { tokens.push({ type: 'op', value: '&&' }); i += 2; continue; }
        if (c === '|' && expr[i+1] === '|') { tokens.push({ type: 'op', value: '||' }); i += 2; continue; }
        if (c === '=' && expr[i+1] === '=') { tokens.push({ type: 'op', value: '==' }); i += 2; continue; }
        if (c === '!' && expr[i+1] === '=') { tokens.push({ type: 'op', value: '!=' }); i += 2; continue; }
        if (c === '!') { tokens.push({ type: 'op', value: '!' }); i++; continue; }
        if (c === '(') {
            let depth = 1, j = i + 1;
            while (j < expr.length && depth > 0) { if (expr[j] === '(') depth++; else if (expr[j] === ')') depth--; j++; }
            const inner = expr.slice(i + 1, j - 1);
            tokens.push({ type: 'paren', value: buildTree(tokenizeCondition(inner)) }); i = j; continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1; while (j < expr.length && expr[j] !== c) j++;
            tokens.push({ type: 'literal', value: expr.slice(i + 1, j) }); i = j + 1; continue;
        }
        if (/\d/.test(c)) {
            let j = i; while (j < expr.length && /[\d.]/.test(expr[j])) j++;
            tokens.push({ type: 'literal', value: parseFloat(expr.slice(i, j)) }); i = j; continue;
        }
        if (/[a-zA-Z_]/.test(c)) {
            let j = i; while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
            const name = expr.slice(i, j);
            if (name === 'true') tokens.push({ type: 'literal', value: true });
            else if (name === 'false') tokens.push({ type: 'literal', value: false });
            else tokens.push({ type: 'ident', value: name });
            i = j; continue;
        }
        i++;
    }
    return tokens;
}

function buildTree(tokens) {
    let pos = 0;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }
    function parseOr() { let left = parseAnd(); while (peek() && peek().type === 'op' && peek().value === '||') { next(); left = { type: 'or', left, right: parseAnd() }; } return left; }
    function parseAnd() { let left = parseComparison(); while (peek() && peek().type === 'op' && peek().value === '&&') { next(); left = { type: 'and', left, right: parseComparison() }; } return left; }
    function parseComparison() { let left = parseUnary(); if (peek() && peek().type === 'op' && (peek().value === '==' || peek().value === '!=')) { const op = next().value; return { type: 'compare', op, left, right: parseUnary() }; } return left; }
    function parseUnary() { if (peek() && peek().type === 'op' && peek().value === '!') { next(); return { type: 'not', value: parseUnary() }; } return parseAtom(); }
    function parseAtom() { const t = next(); if (!t) return { type: 'lit', value: false }; if (t.type === 'paren') return t.value; if (t.type === 'literal') return { type: 'lit', value: t.value }; if (t.type === 'ident') return { type: 'ident', name: t.value }; return { type: 'lit', value: false }; }
    return parseOr();
}

function applyEffects(effects) {
    if (!effects || typeof effects !== 'object') return;
    for (const key of Object.keys(effects)) {
        if (!(key in storyState)) { console.warn('Неизвестный флаг:', key); continue; }
        storyState[key] = effects[key];
    }
}

// ============================================================
//  DOM
// ============================================================
const video = document.getElementById('videoPlayer');
const insertPlayer = document.getElementById('insertPlayer');
const choiceAmbient = document.getElementById('choiceAmbient');
const overlay = document.getElementById('overlay');
const conditionalOverlaysEl = document.getElementById('conditionalOverlays');
const controls = document.getElementById('controls');
const player = document.getElementById('player');
const endMessage = document.getElementById('endMessage');
const timeline = document.getElementById('timeline');
const timelineProgress = document.getElementById('timelineProgress');
const timelineBuffered = document.getElementById('timelineBuffered');
const timelineThumb = document.getElementById('timelineThumb');
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
const playPauseBtn = document.getElementById('playPauseBtn');
const volumeBtn = document.getElementById('volumeBtn');
const volumeSlider = document.getElementById('volumeSlider');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const episodeBtn = document.getElementById('episodeBtn');
const epNumberEl = document.getElementById('epNumber');
const seriesTitleText = document.getElementById('seriesTitleText');
const episodesPopup = document.getElementById('episodesPopup');
const popupList = document.getElementById('popupList');
const popupClose = document.getElementById('popupClose');
const backHomeBtn = document.getElementById('backHomeBtn');
const restartProgressBtn = document.getElementById('restartProgressBtn');
const choiceCountdownEl = document.getElementById('choiceCountdown');
const countdownNumberEl = document.getElementById('countdownNumber');
const countdownRingEl = document.getElementById('countdownRing');
const bufferingSpinner = document.getElementById('bufferingSpinner');
const skipBtn = document.getElementById('skipBtn');

const params = new URLSearchParams(window.location.search);
const episodeIdFromUrl = params.get('episodeId');
const debugMode = params.get('debug') === '1';

let hideControlsTimeout = null;
let isDraggingTimeline = false;
let isAutoAdvancing = false;
let lastTime = 0;
let skipButtonVisible = false;

function getActiveVideo() { return isInsertPlaying ? insertPlayer : video; }

function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ============================================================
//  ЗАГРУЗКА СЕРИАЛА
// ============================================================
async function loadSeries() {
    const res = await fetch('/api/series');
    if (!res.ok) throw new Error('Не удалось загрузить сериал');
    seriesData = await res.json();
    if (seriesTitleText) seriesTitleText.textContent = seriesData.title || 'За край';
    episodesList = seriesData.episodes || [];
    renderEpisodesList();
}

function renderEpisodesList() {
    popupList.innerHTML = '';
    episodesList.forEach(ep => {
        const item = document.createElement('div');
        item.className = 'ep-item' + (ep.id == currentEpisodeId ? ' active' : '');
        const cover = ep.cover && ep.cover.trim() !== '' ? `/uploads/${ep.cover}` : `/images/frame${ep.episode_number}.jpg`;
        item.innerHTML = `
            <span class="ep-num">${ep.episode_number}</span>
            <div class="ep-info"><span class="ep-title">${ep.title || 'Без названия'}</span></div>
            <div class="ep-cover" style="background-image: url('${cover}'), linear-gradient(145deg, #1a1a3e, #0b0b1a);"></div>
        `;
        item.addEventListener('click', () => {
            loadEpisode(ep.id, null);
            episodesPopup.classList.add('hidden');
        });
        popupList.appendChild(item);
    });
}

async function loadEpisode(epId, sceneIdToLoad = null) {
    currentEpisodeId = epId;
    const ep = episodesList.find(e => e.id == epId);
    if (ep && epNumberEl) epNumberEl.textContent = ep.episode_number;

    try {
        const res = await fetch(`/api/episode/${epId}`);
        if (!res.ok) throw new Error('Серия не найдена');
        const episode = await res.json();
        currentEpisodeScenes = episode.scenes || [];

        let targetScene = null;
        if (sceneIdToLoad) {
            targetScene = currentEpisodeScenes.find(s => s.id === sceneIdToLoad);
        }
        if (!targetScene) {
            targetScene = currentEpisodeScenes.find(s => s.type === 'start') || currentEpisodeScenes[0];
        }
        if (!targetScene) {
            alert('В этой серии нет сцен');
            return;
        }
        await loadScene(targetScene.id);
        renderEpisodesList();

        fetch('/api/stats/view', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewerId: getViewerId(), type: 'start' })
        }).catch(() => {});
    } catch (err) {
        console.error(err);
        alert('Ошибка загрузки серии');
    }
}

// ============================================================
//  RESET / COMPUTE CHOICE STATE
// ============================================================
function resetChoiceState() {
    if (sceneChoiceState.timeoutId) clearTimeout(sceneChoiceState.timeoutId);
    if (sceneChoiceState.countdownId) clearInterval(sceneChoiceState.countdownId);
    sceneChoiceState.pauseAt = null;
    sceneChoiceState.triggered = false;
    sceneChoiceState.resolved = false;
    sceneChoiceState.timeoutAt = 0;
    sceneChoiceState.timeoutDuration = 10;
    if (choiceCountdownEl) choiceCountdownEl.classList.add('hidden');
    stopChoiceAmbient();
}

function computeChoicePauseAt(scene) {
    if (!scene) return null;
    if (typeof scene.pause_at === 'number') return scene.pause_at;
    if (!scene.choices || !scene.choices.length) return null;
    const starts = scene.choices.map(c => c.area && c.area.time_start).filter(t => typeof t === 'number' && !isNaN(t));
    if (!starts.length) return null;
    return Math.min(...starts);
}

// ============================================================
//  МУЗЫКА НА ВРЕМЯ ВЫБОРА
// ============================================================
function startChoiceAmbient() {
    if (!choiceAmbient) return;
    if (!choiceAmbient.src) choiceAmbient.src = '/uploads/choice_ambient.mp3';
    choiceAmbient.volume = 0.5;
    try { choiceAmbient.currentTime = 0; } catch (e) {}
    safePlay(choiceAmbient);
}

function stopChoiceAmbient() {
    if (!choiceAmbient) return;
    try { choiceAmbient.pause(); choiceAmbient.currentTime = 0; } catch (e) {}
}

// ============================================================
//  КНОПКА «СЛЕДУЮЩАЯ СЕРИЯ»
// ============================================================
function showSkipButton() {
    if (!skipBtn || skipButtonVisible) return;
    skipButtonVisible = true;
    skipBtn.classList.remove('hidden');
}

function hideSkipButton() {
    if (!skipBtn || !skipButtonVisible) return;
    skipButtonVisible = false;
    skipBtn.classList.add('hidden');
}

function checkSkipButton(cur, dur) {
    if (!currentScene || currentScene.type !== 'final') {
        hideSkipButton();
        return;
    }
    if (!dur || dur <= 0) return;
    const remaining = dur - cur;
    if (remaining <= SKIP_BUTTON_DELAY && remaining > 0) showSkipButton();
    else if (remaining <= 0) hideSkipButton();
}

function goToNextEpisode() {
    const idx = episodesList.findIndex(e => e.id == currentEpisodeId);
    const nextEp = (idx >= 0 && idx < episodesList.length - 1) ? episodesList[idx + 1] : null;
    if (nextEp) { isAutoAdvancing = true; loadEpisode(nextEp.id, null); }
    else { endMessage.classList.remove('hidden'); clearProgress(); }
}

if (skipBtn) {
    skipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideSkipButton();
        goToNextEpisode();
    });
}

// ============================================================
//  ЗАГРУЗКА СЦЕНЫ
// ============================================================
async function loadScene(sceneId) {
    try {
        resetChoiceState();
        hideSkipButton();
        const res = await fetch(`/api/scene/${sceneId}`);
        if (!res.ok) throw new Error('Сцена не найдена');
        const scene = await res.json();

        currentSceneId = scene.id;
        currentScene = scene;
        isAutoAdvancing = false;
        endMessage.classList.add('hidden');

        if (scene.scene_effects) applyEffects(scene.scene_effects);

        if (scene.video && scene.video.trim() !== '') {
            video.src = `/uploads/${scene.video}`;
            video.load();
            video.play().catch(() => {
                controls.classList.add('visible');
                player.classList.add('show-controls');
            });
        } else {
            video.removeAttribute('src');
            video.load();
        }

        buildChoiceAreas(scene);
        sceneChoiceState.pauseAt = computeChoicePauseAt(scene);
        sceneChoiceState.timeoutDuration = typeof scene.choice_timeout === 'number' ? scene.choice_timeout : 10;

        conditionalOverlaysEl.innerHTML = '';
        lastTime = 0;
        saveProgress();

        if (shouldPreload()) {
            setTimeout(() => preloadNextScene(), PRELOAD_DELAY);
        }
    } catch (err) {
        console.error(err);
    }
}

function buildChoiceAreas(scene) {
    if (!overlay) return;
    overlay.innerHTML = '';
    if (!scene.choices) return;

    scene.choices.forEach(choice => {
        const area = choice.area;
        if (!area) return;
        const div = document.createElement('div');
        div.className = 'area';
        div.style.left = area.x + '%';
        div.style.top = area.y + '%';
        div.style.width = area.width + '%';
        div.style.height = area.height + '%';
        div.style.display = 'none';
        div.dataset.choiceId = choice.id;

        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = choice.label || '';
        div.appendChild(label);

        div.addEventListener('click', (e) => {
            e.stopPropagation();
            if (sceneChoiceState.resolved) return;
            handleChoice(choice);
        });
        overlay.appendChild(div);
    });
}

function triggerChoicePause() {
    if (!currentScene || !currentScene.choices || sceneChoiceState.resolved) return;
    sceneChoiceState.triggered = true;

    if (video) video.pause();
    if (overlay) overlay.querySelectorAll('.area').forEach(el => el.style.display = 'flex');

    startChoiceAmbient();

    const timeout = sceneChoiceState.timeoutDuration;
    sceneChoiceState.timeoutAt = Date.now() + timeout * 1000;

    if (choiceCountdownEl) choiceCountdownEl.classList.remove('hidden');
    if (countdownNumberEl) countdownNumberEl.textContent = timeout;
    const circumference = 2 * Math.PI * 19;
    if (countdownRingEl) {
        countdownRingEl.style.strokeDasharray = circumference;
        countdownRingEl.style.strokeDashoffset = 0;
    }

    sceneChoiceState.countdownId = setInterval(() => {
        const remaining = Math.max(0, (sceneChoiceState.timeoutAt - Date.now()) / 1000);
        if (countdownNumberEl) countdownNumberEl.textContent = Math.ceil(remaining);
        const ratio = remaining / timeout;
        if (countdownRingEl) countdownRingEl.style.strokeDashoffset = circumference * (1 - ratio);
    }, 100);

    sceneChoiceState.timeoutId = setTimeout(() => {
        if (!sceneChoiceState.resolved) handleNoChoice();
    }, timeout * 1000);
}

async function handleChoice(choice) {
    sceneChoiceState.resolved = true;
    if (sceneChoiceState.timeoutId) clearTimeout(sceneChoiceState.timeoutId);
    if (sceneChoiceState.countdownId) clearInterval(sceneChoiceState.countdownId);
    choiceCountdownEl.classList.add('hidden');
    if (overlay) overlay.querySelectorAll('.area').forEach(el => el.style.display = 'none');
    stopChoiceAmbient();

    const fallbackNext = choice.next || (currentScene && currentScene.next) || null;

    if (choice.after_choice && choice.after_choice.video) {
        await playInsert(choice.after_choice.video);
        await continueAfterInsert(choice.after_choice, fallbackNext);
    } else if (choice.next) {
        await loadScene(choice.next);
    } else if (fallbackNext) {
        await loadScene(fallbackNext);
    }
}

async function handleNoChoice() {
    if (sceneChoiceState.resolved) return;
    sceneChoiceState.resolved = true;
    if (sceneChoiceState.timeoutId) clearTimeout(sceneChoiceState.timeoutId);
    if (sceneChoiceState.countdownId) clearInterval(sceneChoiceState.countdownId);
    choiceCountdownEl.classList.add('hidden');
    if (overlay) overlay.querySelectorAll('.area').forEach(el => el.style.display = 'none');
    stopChoiceAmbient();

    const nc = (currentScene && currentScene.no_choice) || {};
    const fallbackNext = nc.next || (currentScene && currentScene.next) || null;

    if (nc.after_choice && nc.after_choice.video) {
        await playInsert(nc.after_choice.video);
        await continueAfterInsert(nc.after_choice, fallbackNext);
    } else if (nc.next) {
        await loadScene(nc.next);
    } else if (fallbackNext) {
        await loadScene(fallbackNext);
    }
}

async function continueAfterInsert(afterChoice, fallbackNext) {
    if (afterChoice.resume_at != null) {
        const dur = (video && video.duration) || 0;
        if (dur > 0 && afterChoice.resume_at >= dur - 0.5) {
            if (video) video.currentTime = dur - 0.1;
            setTimeout(() => onSceneEnded(), 150);
            return;
        }
        if (video) {
            video.currentTime = Math.min(afterChoice.resume_at, dur > 0 ? dur - 0.1 : afterChoice.resume_at);
            safePlay(video);
        }
        showControls();
        return;
    }
    if (fallbackNext) { await loadScene(fallbackNext); return; }
    onSceneEnded();
}

function onSceneEnded() {
    if (isAutoAdvancing) return;
    const scene = currentScene;
    if (!scene) return;

    hideSkipButton();

    if (scene.next) {
        isAutoAdvancing = true;
        setTimeout(() => loadScene(scene.next), 300);
        return;
    }

    const idx = currentEpisodeScenes.findIndex(s => s.id === currentSceneId);
    if (idx >= 0 && idx < currentEpisodeScenes.length - 1) {
        const nextScene = currentEpisodeScenes[idx + 1];
        isAutoAdvancing = true;
        setTimeout(() => loadScene(nextScene.id), 300);
        return;
    }

    goToNextEpisode();
}

function playInsert(videoFile) {
    return new Promise((resolve) => {
        if (!insertPlayer) { resolve(); return; }
        const src = `/uploads/${videoFile}`;
        insertPlayer.src = src;
        insertPlayer.classList.add('active');
        insertPlayer.currentTime = 0;

        isInsertPlaying = true;
        if (playPauseBtn) playPauseBtn.classList.add('playing');
        if (currentTimeEl) currentTimeEl.textContent = '0:00';
        if (durationEl) durationEl.textContent = '0:00';
        if (timelineProgress) timelineProgress.style.width = '0%';
        if (timelineThumb) timelineThumb.style.left = '0%';
        if (timelineBuffered) timelineBuffered.style.width = '0%';

        if (video) video.pause();

        let resolved = false;
        const finish = () => {
            if (resolved) return;
            resolved = true;
            insertPlayer.removeEventListener('ended', finish);
            insertPlayer.removeEventListener('error', onError);
            insertPlayer.classList.remove('active');
            insertPlayer.removeAttribute('src');
            insertPlayer.load();
            isInsertPlaying = false;
            if (playPauseBtn) playPauseBtn.classList.remove('playing');
            resolve();
        };

        const onError = () => {
            console.warn('Вставка не загрузилась, пропускаем:', src);
            finish();
        };

        insertPlayer.addEventListener('ended', finish);
        insertPlayer.addEventListener('error', onError);

        insertPlayer.play().catch(() => {
            insertPlayer.muted = true;
            insertPlayer.play().catch(() => onError());
        });

        setTimeout(() => {
            if (!resolved && insertPlayer.readyState < 2) finish();
        }, 5000);
    });
}

// ============================================================
//  ОБНОВЛЕНИЕ UI
// ============================================================
function onActiveTimeUpdate() {
    const v = getActiveVideo();
    if (!v) return;
    const cur = v.currentTime;
    const dur = v.duration || 0;

    if (dur > 0) {
        const percent = (cur / dur) * 100;
        if (timelineProgress) timelineProgress.style.width = percent + '%';
        if (timelineThumb) timelineThumb.style.left = percent + '%';
    }
    if (currentTimeEl) currentTimeEl.textContent = formatTime(cur);

    if (!isInsertPlaying) {
        if (sceneChoiceState.pauseAt != null
            && !sceneChoiceState.triggered
            && !sceneChoiceState.resolved
            && lastTime < sceneChoiceState.pauseAt
            && cur >= sceneChoiceState.pauseAt) {
            triggerChoicePause();
        }
        checkSkipButton(cur, dur);
        lastTime = cur;
    }
}

function onActiveLoadedMetadata() {
    const v = getActiveVideo();
    if (v && durationEl) durationEl.textContent = formatTime(v.duration);
}

function onActiveProgress() {
    const v = getActiveVideo();
    if (!v) return;
    if (v.buffered.length > 0 && v.duration && timelineBuffered) {
        const bufferedEnd = v.buffered.end(v.buffered.length - 1);
        timelineBuffered.style.width = ((bufferedEnd / v.duration) * 100) + '%';
    }
}

function onActivePlay() { if (playPauseBtn) playPauseBtn.classList.add('playing'); showControls(); }
function onActivePause() { if (playPauseBtn) playPauseBtn.classList.remove('playing'); showControls(); }

function showBuffering() { if (bufferingSpinner) bufferingSpinner.classList.add('visible'); }
function hideBuffering() { if (bufferingSpinner) bufferingSpinner.classList.remove('visible'); }

function bindVideoEvents(v) {
    if (!v) return;
    v.addEventListener('timeupdate', onActiveTimeUpdate);
    v.addEventListener('loadedmetadata', onActiveLoadedMetadata);
    v.addEventListener('progress', onActiveProgress);
    v.addEventListener('play', onActivePlay);
    v.addEventListener('pause', onActivePause);
    v.addEventListener('waiting', showBuffering);
    v.addEventListener('stalled', showBuffering);
    v.addEventListener('playing', hideBuffering);
    v.addEventListener('canplay', hideBuffering);
    v.addEventListener('seeked', hideBuffering);
    v.addEventListener('error', hideBuffering);
}

bindVideoEvents(video);
bindVideoEvents(insertPlayer);
if (video) video.addEventListener('ended', onSceneEnded);

function togglePlay() {
    if (sceneChoiceState.triggered && !sceneChoiceState.resolved) return;
    const v = getActiveVideo();
    if (!v) return;
    if (v.paused) safePlay(v);
    else v.pause();
}
if (playPauseBtn) playPauseBtn.addEventListener('click', togglePlay);
if (video) video.addEventListener('click', togglePlay);
if (insertPlayer) insertPlayer.addEventListener('click', togglePlay);

function seekFromEvent(e) {
    if (sceneChoiceState.triggered && !sceneChoiceState.resolved) return;
    if (!timeline) return;
    const rect = timeline.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches?.[0]?.clientX ?? 0);
    let x = clientX - rect.left;
    x = Math.max(0, Math.min(x, rect.width));
    const v = getActiveVideo();
    if (v && v.duration) v.currentTime = (x / rect.width) * v.duration;
}
if (timeline) {
    timeline.addEventListener('mousedown', (e) => { isDraggingTimeline = true; seekFromEvent(e); });
    timeline.addEventListener('touchstart', (e) => { isDraggingTimeline = true; seekFromEvent(e); }, { passive: true });
}
document.addEventListener('mousemove', (e) => { if (isDraggingTimeline) seekFromEvent(e); });
document.addEventListener('mouseup', () => { isDraggingTimeline = false; });
document.addEventListener('touchmove', (e) => { if (isDraggingTimeline) seekFromEvent(e); }, { passive: true });
document.addEventListener('touchend', () => { isDraggingTimeline = false; });

if (volumeSlider) {
    volumeSlider.addEventListener('input', (e) => {
        const v = getActiveVideo();
        if (!v) return;
        v.volume = parseFloat(e.target.value);
        v.muted = v.volume === 0;
        updateVolumeIcon();
    });
}
if (volumeBtn) {
    volumeBtn.addEventListener('click', () => {
        const v = getActiveVideo();
        if (!v) return;
        v.muted = !v.muted;
        updateVolumeIcon();
    });
}
function updateVolumeIcon() {
    if (!volumeBtn) return;
    const v = getActiveVideo();
    if (!v) return;
    volumeBtn.classList.remove('volume-high', 'volume-low', 'volume-mute');
    if (v.muted || v.volume === 0) volumeBtn.classList.add('volume-mute');
    else if (v.volume < 0.5) volumeBtn.classList.add('volume-low');
    else volumeBtn.classList.add('volume-high');
}
updateVolumeIcon();

if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => {
        const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (isIOS) {
            player.classList.toggle('ios-immersive');
            if (player.classList.contains('ios-immersive')) setTimeout(() => window.scrollTo(0, 1), 50);
            return;
        }
        if (video && video.webkitEnterFullscreen && !document.fullscreenEnabled) {
            video.webkitEnterFullscreen();
            return;
        }
        if (!document.fullscreenElement) {
            if (player) player.requestFullscreen().catch(err => console.log(err));
        } else {
            document.exitFullscreen();
        }
    });
}

function showControls() {
    if (!controls || !player) return;
    controls.classList.add('visible');
    player.classList.add('show-controls');
    clearTimeout(hideControlsTimeout);
    const v = getActiveVideo();
    if (!v) return;
    const keepVisible = sceneChoiceState.triggered && !sceneChoiceState.resolved;
    if (!v.paused || keepVisible) {
        if (!keepVisible) {
            hideControlsTimeout = setTimeout(() => {
                controls.classList.remove('visible');
                player.classList.remove('show-controls');
            }, 3000);
        }
    }
}
if (player) {
    player.addEventListener('mousemove', showControls);
    player.addEventListener('mouseleave', () => {
        const keepVisible = sceneChoiceState.triggered && !sceneChoiceState.resolved;
        if (keepVisible) return;
        const v = getActiveVideo();
        if (v && !v.paused) {
            if (controls) controls.classList.remove('visible');
            if (player) player.classList.remove('show-controls');
        }
    });
}

if (episodeBtn) {
    episodeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        episodesPopup.classList.toggle('hidden');
        showControls();
    });
}
if (popupClose) popupClose.addEventListener('click', () => episodesPopup.classList.add('hidden'));
document.addEventListener('click', (e) => {
    if (episodesPopup && !episodesPopup.classList.contains('hidden') &&
        !episodesPopup.contains(e.target) &&
        episodeBtn && !episodeBtn.contains(e.target)) {
        episodesPopup.classList.add('hidden');
    }
});

if (backHomeBtn) {
    backHomeBtn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen().finally(() => { window.location.href = '/'; });
        else window.location.href = '/';
    });
}
if (restartProgressBtn) {
    restartProgressBtn.addEventListener('click', () => {
        if (!confirm('Начать сериал заново? Весь прогресс будет сброшен.')) return;
        clearProgress();
        if (episodesList.length > 0) loadEpisode(episodesList[0].id, null);
    });
}
const restartBtn = document.getElementById('restartBtn');
if (restartBtn) {
    restartBtn.addEventListener('click', () => {
        clearProgress();
        if (episodesList.length > 0) loadEpisode(episodesList[0].id, null);
    });
}
const backBtn = document.getElementById('backBtn');
if (backBtn) backBtn.addEventListener('click', () => { window.location.href = '/'; });

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    switch (e.code) {
        case 'Space': e.preventDefault(); if (sceneChoiceState.triggered && !sceneChoiceState.resolved) return; togglePlay(); break;
        case 'ArrowRight': if (sceneChoiceState.triggered && !sceneChoiceState.resolved) return; { const v = getActiveVideo(); if (v) v.currentTime += 5; } showControls(); break;
        case 'ArrowLeft': if (sceneChoiceState.triggered && !sceneChoiceState.resolved) return; { const v = getActiveVideo(); if (v) v.currentTime -= 5; } showControls(); break;
        case 'KeyF': if (fullscreenBtn) fullscreenBtn.click(); break;
    }
});

(async () => {
    try {
        await loadSeries();
        const saved = await loadStoryDataAsync();
        if (saved && saved.episodeId && saved.sceneId) {
            storyState = { ...initialStoryState, ...(saved.storyState || {}) };
            playedInserts = saved.playedInserts || [];
            watchedEpisodes = saved.watchedEpisodes || [];
            await loadEpisode(saved.episodeId, saved.sceneId);
            return;
        }
        if (episodeIdFromUrl) await loadEpisode(episodeIdFromUrl, null);
        else if (episodesList.length > 0) await loadEpisode(episodesList[0].id, null);
    } catch (err) {
        console.error(err);
    }
})();
