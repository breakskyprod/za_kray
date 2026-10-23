// Режим опубликованного проекта: ?p=<pid>
// Подключается ДО scripts.js (series.html) и ДО player_v2.js (player_v2.html).
// Без ?p= ничего не меняет, поэтому «За край» работает как раньше.
(function () {
    var p = new URLSearchParams(location.search).get('p');
    if (!p || !/^[a-f0-9]{16}$/.test(p)) return;

    function withP(url) {
        if (!/^\/api\/(series|episode\/|scene\/)/.test(url)) return url;
        if (/[?&]p=/.test(url)) return url;
        return url + (url.indexOf('?') < 0 ? '?' : '&') + 'p=' + p;
    }

    // 1) все запросы серии уходят с ?p=
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        if (typeof input === 'string') {
            return origFetch(withP(input), init);
        }
        if (input && input.url) {
            var u = withP(input.url);
            if (u !== input.url) return origFetch(new Request(u, input), init);
        }
        return origFetch(input, init);
    };

    document.addEventListener('DOMContentLoaded', function () {
        // 2) ссылки на плеер получают ?p=
        document.querySelectorAll('a[href*="player_v2"]').forEach(function (a) {
            var h = a.getAttribute('href');
            if (h && !/[?&]p=/.test(h)) {
                a.setAttribute('href', h + (h.indexOf('?') < 0 ? '?' : '&') + 'p=' + p);
            }
        });

        // 3) заголовок страницы серии берётся из проекта, а не «За край»
        var titleEl = document.getElementById('heroTitleText');
        var imgEl = document.getElementById('heroTitleImg');
        origFetch('/api/series?p=' + p)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (!d || !d.title) return;
                document.title = d.title;
                if (titleEl) { titleEl.textContent = d.title; titleEl.style.display = 'block'; }
                if (imgEl) imgEl.style.display = 'none';
            })
            .catch(function () {});
    });
})();