// Универсальный режим плеера: /player_v2.html?p=<pid> открывает любой опубликованный проект.
// Подключается ДО player_v2.js. Без ?p= ничего не меняет.
(function () {
    var pid = new URLSearchParams(location.search).get('p');
    if (!pid || !/^[a-f0-9]{16}$/.test(pid)) return;

    var API = /^\/api\/(series|episode\/|scene\/)/;

    function addP(url) {
        if (!API.test(url) || /[?&]p=/.test(url)) return url;
        return url + (url.indexOf('?') < 0 ? '?' : '&') + 'p=' + pid;
    }

    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        if (typeof input === 'string') {
            return origFetch(addP(input), init);
        }
        if (input && typeof input.url === 'string') {
            var u = addP(input.url);
            if (u !== input.url) return origFetch(new Request(u, input), init);
        }
        return origFetch(input, init);
    };
})();

// Кнопка «На главную» -> «Назад»: возвращает на страницу, откуда открыли плеер.
(function () {
    var OLD_TXT = '\u041d\u0430 \u0433\u043b\u0430\u0432\u043d\u0443\u044e'; // «На главную»
    var NEW_TXT = '\u041d\u0430\u0437\u0430\u0434';                           // «Назад»

    function goBack(e) {
        if (e) e.preventDefault();
        if (window.history.length > 1) window.history.back();
        else window.location.href = '/';
    }

    function fixBackButton() {
        var els = Array.prototype.slice.call(document.querySelectorAll('a, button'));
        els.forEach(function (el) {
            var text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text !== OLD_TXT) return;

            // клон убирает старые обработчики и onclick, которые вели на главную
            var clone = el.cloneNode(true);
            clone.removeAttribute('onclick');
            if (clone.tagName === 'A') clone.setAttribute('href', '#');

            var walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
            var node;
            while ((node = walker.nextNode())) {
                if (node.nodeValue.indexOf(OLD_TXT) >= 0) {
                    node.nodeValue = node.nodeValue.replace(OLD_TXT, NEW_TXT);
                }
            }

            clone.addEventListener('click', goBack);
            el.parentNode.replaceChild(clone, el);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fixBackButton);
    } else {
        fixBackButton();
    }
})();

// Автопереход: когда серия закончилась, открываем следующую серию сериала
document.addEventListener('DOMContentLoaded', function () {
    var pid = new URLSearchParams(location.search).get('p');
    if (!pid || !/^[a-f0-9]{16}$/.test(pid)) return;

    var nextHref = null;
    fetch('/api/next-episode/' + pid)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && d.next) nextHref = d.next.href; })
        .catch(function () {});

    // goToNextEpisode уже есть в player_v2.js; если следующей серии нет, работает старая логика
    if (typeof window.goToNextEpisode !== 'function') return;
    var orig = window.goToNextEpisode;
    window.goToNextEpisode = function () {
        if (nextHref) { window.location.href = nextHref; return; }
        return orig.apply(this, arguments);
    };
});