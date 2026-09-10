const video = document.getElementById('videoPlayer');
const overlay = document.getElementById('overlay');
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

let currentGlavaId = null;
let currentGlavaType = null;
let transitions = [];
let episodesList = [];
let currentEpisodeId = null;
let hideControlsTimeout = null;
let isDraggingTimeline = false;
let isAutoAdvancing = false;

const params = new URLSearchParams(window.location.search);
const episodeIdFromUrl = params.get('episodeId');

// ===== ФОРМАТ ВРЕМЕНИ =====
function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ===== ПРОГРЕСС В LOCALSTORAGE =====
function saveProgress(episodeId, glavaId) {
    try {
        localStorage.setItem('series_progress', JSON.stringify({
            episodeId, glavaId, savedAt: Date.now()
        }));
    } catch (e) {}
}

function loadProgress() {
    try {
        const raw = localStorage.getItem('series_progress');
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

function clearProgress() {
    try { localStorage.removeItem('series_progress'); } catch (e) {}
}

// ===== СПИСОК СЕРИЙ =====
async function loadSeries() {
    const res = await fetch('/api/series');
    const series = await res.json();
    seriesTitleText.textContent = series.title || '';
    episodesList = series.episodes || [];
    renderEpisodesList();
}

function renderEpisodesList() {
    popupList.innerHTML = '';
    episodesList.forEach(ep => {
        const item = document.createElement('div');
        item.className = 'ep-item' + (ep.id == currentEpisodeId ? ' active' : '');

        const cover = ep.cover && ep.cover.trim() !== ''
            ? `/uploads/${ep.cover}`
            : `/images/frame${ep.episode_number}.jpg`;

        item.innerHTML = `
            <span class="ep-num">${ep.episode_number}</span>
            <div class="ep-info">
                <span class="ep-title">${ep.title || 'Без названия'}</span>
            </div>
            <div class="ep-cover" style="background-image: url('${cover}'), linear-gradient(145deg, #1a1a3e, #0b0b1a);"></div>
        `;

        item.addEventListener('click', () => {
            loadEpisode(ep.id, null);
            episodesPopup.classList.add('hidden');
        });
        popupList.appendChild(item);
    });
}

// ===== ЗАГРУЗКА СЕРИИ =====
async function loadEpisode(epId, glavaIdToLoad = null) {
    currentEpisodeId = epId;
    const ep = episodesList.find(e => e.id == epId);
    if (ep) epNumberEl.textContent = ep.episode_number;

    try {
        const res = await fetch(`/api/episode/${epId}`);
        if (!res.ok) throw new Error('Серия не найдена');
        const episode = await res.json();

        let targetGlava = null;
        if (glavaIdToLoad) {
            targetGlava = episode.glavas.find(g => g.id === glavaIdToLoad);
        }
        if (!targetGlava) {
            targetGlava = episode.glavas.find(g => g.type === 'start') || episode.glavas[0];
        }
        if (!targetGlava) {
            alert('В этой серии нет глав');
            return;
        }
        await loadGlava(targetGlava.id);
        renderEpisodesList();
    } catch (err) {
        console.error(err);
        alert('Ошибка загрузки серии');
    }
}

// ===== ЗАГРУЗКА ГЛАВЫ =====
async function loadGlava(glavaId) {
    try {
        const res = await fetch(`/api/glava/${glavaId}`);
        if (!res.ok) throw new Error('Глава не найдена');
        const glava = await res.json();

        currentGlavaId = glava.id;
        currentGlavaType = glava.glava_type;
        isAutoAdvancing = false;
        endMessage.classList.add('hidden');

        const url = glava.video_url || '';
        if (url.trim() !== '') {
            video.src = url.startsWith('http') ? url : `/uploads/${url}`;
        } else {
            video.removeAttribute('src');
            video.load();
        }

        video.load();
        video.play().catch(() => {
            controls.classList.add('visible');
            player.classList.add('show-controls');
        });

        // Области
        transitions = glava.transitions || [];
        overlay.innerHTML = '';
        transitions.forEach(tr => {
            const area = typeof tr.area_data === 'string' ? JSON.parse(tr.area_data) : tr.area_data;
            const div = document.createElement('div');
            div.className = 'area';
            div.style.left = area.x + '%';
            div.style.top = area.y + '%';
            div.style.width = area.width + '%';
            div.style.height = area.height + '%';
            div.style.display = 'none';

            const label = document.createElement('div');
            label.className = 'label';
            label.textContent = area.label || 'Выбрать';
            div.appendChild(label);

            div.addEventListener('click', (e) => {
                e.stopPropagation();
                loadGlava(tr.to_glava_id);
            });
            overlay.appendChild(div);
        });

        saveProgress(currentEpisodeId, glava.id);

        fetch('/api/stats/view', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ glavaId: glava.id })
        }).catch(() => {});
    } catch (err) {
        console.error(err);
    }
}

// ===== СЛЕДУЮЩАЯ СЕРИЯ =====
function findNextEpisode() {
    const idx = episodesList.findIndex(e => e.id == currentEpisodeId);
    if (idx === -1 || idx >= episodesList.length - 1) return null;
    return episodesList[idx + 1];
}

// ===== АВТОПЕРЕХОД =====
video.addEventListener('ended', () => {
    if (isAutoAdvancing) return;
    const isFinal = currentGlavaType === 'final' || transitions.length === 0;
    if (!isFinal) return;

    const nextEp = findNextEpisode();
    if (nextEp) {
        isAutoAdvancing = true;
        setTimeout(() => loadEpisode(nextEp.id, null), 500);
    } else {
        endMessage.classList.remove('hidden');
        clearProgress();
    }
});

// ===== ТАЙМЛАЙН =====
video.addEventListener('timeupdate', () => {
    const cur = video.currentTime;
    const dur = video.duration || 0;

    if (dur > 0) {
        const percent = (cur / dur) * 100;
        timelineProgress.style.width = percent + '%';
        timelineThumb.style.left = percent + '%';
    }

    currentTimeEl.textContent = formatTime(cur);

    const areaDivs = overlay.querySelectorAll('.area');
    areaDivs.forEach((div, index) => {
        const tr = transitions[index];
        if (!tr) return;
        const area = typeof tr.area_data === 'string' ? JSON.parse(tr.area_data) : tr.area_data;
        const start = area.time_start || 0;
        const end = area.time_end || 9999;
        div.style.display = (cur >= start && cur <= end) ? 'block' : 'none';
    });
});

video.addEventListener('loadedmetadata', () => {
    durationEl.textContent = formatTime(video.duration);
});

video.addEventListener('progress', () => {
    if (video.buffered.length > 0 && video.duration) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        const percent = (bufferedEnd / video.duration) * 100;
        timelineBuffered.style.width = percent + '%';
    }
});

// ===== PLAY / PAUSE =====
function togglePlay() {
    if (video.paused) video.play();
    else video.pause();
}

video.addEventListener('play', () => {
    playPauseBtn.classList.add('playing');
    showControls();
});

video.addEventListener('pause', () => {
    playPauseBtn.classList.remove('playing');
    showControls();
});

playPauseBtn.addEventListener('click', togglePlay);
video.addEventListener('click', togglePlay);

// ===== ПЕРЕМОТКА =====
function seekFromEvent(e) {
    const rect = timeline.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches?.[0]?.clientX ?? 0);
    let x = clientX - rect.left;
    x = Math.max(0, Math.min(x, rect.width));
    const percent = x / rect.width;
    if (video.duration) video.currentTime = percent * video.duration;
}

timeline.addEventListener('mousedown', (e) => { isDraggingTimeline = true; seekFromEvent(e); });
document.addEventListener('mousemove', (e) => { if (isDraggingTimeline) seekFromEvent(e); });
document.addEventListener('mouseup', () => { isDraggingTimeline = false; });
timeline.addEventListener('touchstart', (e) => { isDraggingTimeline = true; seekFromEvent(e); }, { passive: true });
document.addEventListener('touchmove', (e) => { if (isDraggingTimeline) seekFromEvent(e); }, { passive: true });
document.addEventListener('touchend', () => { isDraggingTimeline = false; });

// ===== ГРОМКОСТЬ =====
volumeSlider.addEventListener('input', (e) => {
    video.volume = parseFloat(e.target.value);
    video.muted = video.volume === 0;
    updateVolumeIcon();
});

volumeBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    updateVolumeIcon();
});

function updateVolumeIcon() {
    volumeBtn.classList.remove('volume-high', 'volume-low', 'volume-mute');
    if (video.muted || video.volume === 0) {
        volumeBtn.classList.add('volume-mute');
    } else if (video.volume < 0.5) {
        volumeBtn.classList.add('volume-low');
    } else {
        volumeBtn.classList.add('volume-high');
    }
}

// Инициализация иконки при старте
updateVolumeIcon();

// ===== ПОЛНЫЙ ЭКРАН =====
fullscreenBtn.addEventListener('click', () => {
    // iOS Safari: только через нативный метод видео
    if (video.webkitEnterFullscreen && !document.fullscreenEnabled) {
        video.webkitEnterFullscreen();
        return;
    }
    if (!document.fullscreenElement) {
        player.requestFullscreen().catch(err => console.log(err));
    } else {
        document.exitFullscreen();
    }
});

// ===== ПОКАЗ/СКРЫТИЕ ПАНЕЛИ =====
function showControls() {
    controls.classList.add('visible');
    player.classList.add('show-controls');
    clearTimeout(hideControlsTimeout);
    if (!video.paused) {
        hideControlsTimeout = setTimeout(() => {
            controls.classList.remove('visible');
            player.classList.remove('show-controls');
        }, 3000);
    }
}

player.addEventListener('mousemove', showControls);
player.addEventListener('mouseleave', () => {
    if (!video.paused) {
        controls.classList.remove('visible');
        player.classList.remove('show-controls');
    }
});

// ===== ПОПАП СЕРИЙ =====
episodeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    episodesPopup.classList.toggle('hidden');
    showControls();
});

popupClose.addEventListener('click', () => episodesPopup.classList.add('hidden'));

document.addEventListener('click', (e) => {
    if (!episodesPopup.classList.contains('hidden') &&
        !episodesPopup.contains(e.target) &&
        !episodeBtn.contains(e.target)) {
        episodesPopup.classList.add('hidden');
    }
});

// ===== КНОПКА "НА ГЛАВНУЮ" =====
backHomeBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
        document.exitFullscreen().finally(() => { window.location.href = '/'; });
    } else {
        window.location.href = '/';
    }
});

// ===== КНОПКА "ЗАНОВО" =====
restartProgressBtn.addEventListener('click', () => {
    if (!confirm('Начать сериал заново? Весь прогресс будет сброшен.')) return;
    clearProgress();
    if (episodesList.length > 0) {
        loadEpisode(episodesList[0].id, null);
    }
});

// ===== КОНЕЦ =====
document.getElementById('restartBtn').addEventListener('click', () => {
    clearProgress();
    if (episodesList.length > 0) {
        loadEpisode(episodesList[0].id, null);
    }
});
document.getElementById('backBtn').addEventListener('click', () => {
    window.location.href = '/';
});

// ===== ГОРЯЧИЕ КЛАВИШИ =====
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.code) {
        case 'Space': e.preventDefault(); togglePlay(); break;
        case 'ArrowRight': video.currentTime += 5; showControls(); break;
        case 'ArrowLeft': video.currentTime -= 5; showControls(); break;
        case 'KeyF': fullscreenBtn.click(); break;
        case 'Escape': episodesPopup.classList.add('hidden'); break;
    }
});

// ===== ЗАПУСК =====
(async () => {
    await loadSeries();
    const progress = loadProgress();
    if (progress && progress.episodeId && progress.glavaId) {
        const exists = episodesList.some(e => e.id == progress.episodeId);
        if (exists) {
            loadEpisode(progress.episodeId, progress.glavaId);
            return;
        }
    }
    if (episodeIdFromUrl) {
        loadEpisode(episodeIdFromUrl, null);
    } else if (episodesList.length > 0) {
        loadEpisode(episodesList[0].id, null);
    }
})();
