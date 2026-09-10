// ==========================================
//  КАРУСЕЛЬ ВЕРХНЯЯ
// ==========================================
function initCarousel(images) {
    const slider = document.getElementById('heroSlider');
    slider.innerHTML = '';

    if (images && images.length > 0) {
        images.forEach((src, index) => {
            const slide = document.createElement('div');
            slide.className = 'slide' + (index === 0 ? ' active' : '');
            slide.style.backgroundImage = `url(${src})`;
            slider.appendChild(slide);
        });
    } else {
        const fallback = document.createElement('div');
        fallback.className = 'slide active';
        fallback.style.background =
            'radial-gradient(circle at 30% 40%, #f7b73333, #0b0b1a 80%), ' +
            'linear-gradient(145deg, #1a1a3e, #0b0b1a)';
        fallback.style.backgroundBlendMode = 'overlay';
        slider.appendChild(fallback);
        return;
    }

    const slides = slider.querySelectorAll('.slide');
    const total = slides.length;
    let current = 0;

    const dotsContainer = document.createElement('div');
    dotsContainer.className = 'slider-dots';
    for (let i = 0; i < total; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot' + (i === 0 ? ' active' : '');
        dot.addEventListener('click', () => goToSlide(i));
        dotsContainer.appendChild(dot);
    }
    slider.parentElement.appendChild(dotsContainer);

    function goToSlide(index) {
        slides.forEach((s, i) => s.classList.toggle('active', i === index));
        dotsContainer.querySelectorAll('.dot').forEach((d, i) => {
            d.classList.toggle('active', i === index);
        });
        current = index;
    }

    let interval = setInterval(() => goToSlide((current + 1) % total), 5000);

    slider.parentElement.addEventListener('mouseenter', () => clearInterval(interval));
    slider.parentElement.addEventListener('mouseleave', () => {
        interval = setInterval(() => goToSlide((current + 1) % total), 5000);
    });
}

// ==========================================
//  ОСНОВНАЯ ЛОГИКА
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('/api/series');
        if (!response.ok) throw new Error('Не удалось загрузить сериал');
        const series = await response.json();

        document.getElementById('seriesTitle').textContent = series.title || 'Без названия';
        document.getElementById('ageRating').textContent = series.age_rating || '0+';
        document.getElementById('fullDescription').textContent = series.description || 'Описание отсутствует';

        const episodes = series.episodes || [];
        const carousel = document.getElementById('episodesCarousel');
        carousel.innerHTML = '';

        if (episodes.length === 0) {
            carousel.innerHTML = '<p class="loading-text">Нет серий</p>';
        } else {
            episodes.forEach(ep => {
                const card = document.createElement('div');
                card.className = 'episode-card';

                const cover = ep.cover && ep.cover.trim() !== ''
                    ? `/uploads/${ep.cover}`
                    : `/images/frame${ep.episode_number}.jpg`;

                card.style.backgroundImage =
                    `url('${cover}'), linear-gradient(145deg, #1a1a3e, #0b0b1a)`;

                card.innerHTML = `
                    <div class="ep-overlay"></div>
                    <span class="ep-number-badge">${ep.episode_number} серия</span>
                `;

                card.addEventListener('click', () => {
                    window.location.href = `/player.html?episodeId=${ep.id}`;
                });

                carousel.appendChild(card);
            });
        }

        // Кнопка "Смотреть" – учитывает сохранённый прогресс
        document.getElementById('watchBtn').addEventListener('click', () => {
            const saved = localStorage.getItem('series_progress');
            if (saved) {
                try {
                    const p = JSON.parse(saved);
                    if (p.episodeId) {
                        window.location.href = `/player.html?episodeId=${p.episodeId}`;
                        return;
                    }
                } catch (e) {}
            }
            if (episodes.length > 0) {
                window.location.href = `/player.html?episodeId=${episodes[0].id}`;
            } else {
                alert('Нет доступных серий');
            }
        });

        // Кнопка "Поделиться"
        document.getElementById('shareBtn').addEventListener('click', () => {
            const url = window.location.href;
            navigator.clipboard.writeText(url).then(() => {
                alert('Ссылка скопирована!');
            }).catch(() => {
                alert('Скопируйте ссылку вручную: ' + url);
            });
        });

        // Сворачивание описания
        const descBody = document.getElementById('descBody');
        const toggleBtn = document.getElementById('descToggleBtn');
        let isExpanded = false;

        toggleBtn.addEventListener('click', () => {
            isExpanded = !isExpanded;
            if (isExpanded) {
                descBody.classList.add('expanded');
                toggleBtn.textContent = 'Свернуть';
            } else {
                descBody.classList.remove('expanded');
                toggleBtn.textContent = 'Развернуть';
            }
        });

        // ==========================================
        //  КАРУСЕЛЬ КАДРОВ — 6 ШТУК
        // ==========================================
        initCarousel([
            '/images/frame1.jpg',
            '/images/frame2.jpg',
            '/images/frame3.jpg',
            '/images/frame4.jpg',
            '/images/frame5.jpg',
            '/images/frame6.jpg'
        ]);

    } catch (err) {
        console.error(err);
        document.getElementById('seriesTitle').textContent = 'Ошибка загрузки';
        document.getElementById('fullDescription').textContent = 'Не удалось загрузить данные.';
        initCarousel([]);
    }
});