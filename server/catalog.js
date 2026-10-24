// ============================================================
//  ЗА КРАЙ — карусель постеров (A4)
//  Источник данных: GET /api/catalog
//  Запасной вариант: если /api/catalog ещё нет, показываем
//  один заблокированный постер сериала (из /api/series).
//  Не зависит от scripts.js и не мешает его логике.
// ============================================================
(function () {
    'use strict';

    var rail = document.getElementById('catalogCarousel');
    if (!rail) return;

    // Преобразуем имя файла постера в URL.
    // Если указан полный http(s) — оставляем как есть; иначе берём из /uploads/.
    function posterUrl(poster) {
        if (!poster) return '';
        if (/^https?:\/\//i.test(poster)) return poster;
        if (poster.charAt(0) === '/') return poster;
        return '/uploads/' + poster;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Строим один постер-карточку
    function buildCard(item) {
        var locked = !!item.locked;
        var href = item.href || '';
        // Заблокированный или без ссылки — это <div>, иначе кликабельная <a>
        var clickable = !locked && href;
        var el = document.createElement(clickable ? 'a' : 'div');
        el.className = 'poster-card' + (locked ? ' is-locked' : '');
        el.setAttribute('role', 'listitem');
        if (clickable) {
            el.href = href;
            el.setAttribute('aria-label', item.title || 'Смотреть');
        }

        var bg = posterUrl(item.poster);
        var media = document.createElement('div');
        media.className = 'poster-card__media';
        if (bg) {
            media.style.backgroundImage =
                "url('" + bg + "'), linear-gradient(145deg,#1a1a3e,#0b0b1a)";
        }

        // Бейдж типа контента (Сериал / Ролик / своё значение)
        var badgeText = item.badge || (item.type === 'series' ? 'Сериал'
            : item.type === 'clip' ? 'Ролик' : '');
        var inner = '';
        if (locked) {
            inner += '<span class="poster-card__badge poster-card__badge--soon">Скоро</span>';
        } else if (badgeText) {
            inner += '<span class="poster-card__badge">' + escapeHtml(badgeText) + '</span>';
        }

        // Название (при locked — заблюрено + плашка «Скоро»)
        inner += '<div class="poster-card__title' + (locked ? ' is-locked' : '') + '">'
            + escapeHtml(item.title || '') + '</div>';
        if (locked) {
            inner += '<div class="poster-card__lock"><span>Скоро</span></div>';
        }

        media.innerHTML = inner;
        el.appendChild(media);
        return el;
    }

    function render(items) {
        rail.innerHTML = '';
        if (!items || !items.length) {
            rail.innerHTML = '<p class="poster-rail-empty">Пока ничего нет</p>';
            return;
        }
        items.forEach(function (item) {
            rail.appendChild(buildCard(item));
        });
    }

    // Запасной вариант: собрать один постер сериала из /api/series
    function fallbackFromSeries() {
        fetch('/api/series')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (series) {
                if (!series) { render([]); return; }
                render([{
                    id: 'zakray-series',
                    type: 'series',
                    title: series.title || 'За край',
                    // Файл постера положите в server/uploads/poster_zakray.jpg
                    poster: 'poster_zakray.jpg',
                    locked: true,
                    href: ''
                }]);
            })
            .catch(function () { render([]); });
    }

    // Основная загрузка каталога
    fetch('/api/catalog')
        .then(function (r) {
            if (!r.ok) throw new Error('no catalog');
            return r.json();
        })
        .then(function (data) {
            var items = (data && data.items) ? data.items : [];
            if (!items.length) { fallbackFromSeries(); return; }
            render(items);
        })
        .catch(function () {
            // /api/catalog ещё не добавлен на сервере — не ломаемся
            fallbackFromSeries();
        });
})();
