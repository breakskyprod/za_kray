# «За край» — установка и размещение на VPS

Инструкция описывает развёртывание проекта на VPS REG.RU с Ubuntu/Debian, передачу видео вне GitHub, подготовку вариантов качества через FFmpeg, запуск Node.js через systemd и раздачу через Nginx.

> GitHub хранит исходный код и конфигурационные шаблоны. Большие видео в Git не загружаются: их нужно передавать на VPS отдельно по SSH/SFTP. Видеофайлы после обработки лежат на диске сервера в `server/uploads/`.

---

## 1. Как устроен проект

- `frontend/` — HTML, CSS и JavaScript интерфейса и плеера.
- `server/app.js` — Node.js + Express: API и раздача фронтенда.
- `server/data/series_v2.json` — описание серий, сцен, переходов и имена видео.
- `server/data/views.json`, `server/data/states.json` — статистика и сохранённый прогресс в JSON.
- `server/uploads/` — готовые видео, обложки и аудио, доступные зрителю по `/uploads/...`.
- `deploy/` — конфигурационные файлы и скрипты для VPS.

В плеере указаны качества 1080p, 720p, 480p и 360p. Он ищет видео по шаблону:

```text
имя_1080.mp4
имя_720.mp4
имя_480.mp4
имя_360.mp4
```

При выборе «Авто» плеер выбирает начальное качество по устройству и типу соединения, затем пробует доступные варианты меньшего качества. Это не непрерывный адаптивный стриминг: выбранный MP4 не переключается автоматически по ходу просмотра.

---

## 2. Что должно быть в репозитории

Рекомендуемая структура:

```text
za_kray/
├── .gitignore
├── README.md
├── frontend/
├── server/
│   ├── app.js
│   ├── package.json
│   ├── .env.example
│   ├── data/
│   │   └── series_v2.json
│   └── uploads/              # папка на VPS; большие медиа не коммитить
└── deploy/
    ├── nginx.conf
    ├── zakray.service
    ├── backup.sh
    └── transcode-all.sh
```

В GitHub храните исходный код, JSON сценария и конфиги-шаблоны. Не коммитьте:

- `server/node_modules/`;
- настоящий `server/.env`;
- большие видео и аудио;
- резервные копии и рабочие JSON со статистикой/прогрессом.

Если `server/node_modules/` уже отслеживается Git, один раз удалите его из индекса (локальные файлы при этом сохранятся):

```bash
git rm -r --cached server/node_modules
git add .gitignore
git commit -m "chore: stop tracking node_modules"
git push
```

Перед выполнением проверьте `git status`, чтобы не закоммитить `.env`, видео или другие приватные файлы.

---

## 3. Имена видео и связь с `series_v2.json`

Перед загрузкой составьте перечень всех видео, упомянутых в `server/data/series_v2.json`: основная сцена, видео после вариантов A/B, ролики при бездействии и трейлер. Каждое значение `video` или `trailer` должно соответствовать базовому имени готового файла в `server/uploads/`.

Например, если JSON содержит:

```json
"video": "ep1_s1.mp4"
```

в `server/uploads/` должны быть как минимум:

```text
ep1_s1.mp4
ep1_s1_1080.mp4
ep1_s1_720.mp4
ep1_s1_480.mp4
ep1_s1_360.mp4
```

Файл с исходным базовым именем нужен текущему коду плеера как запасной вариант. Скрипт ниже создаёт его копией 720p. Если исходник меньше 720p, видео не будет искусственно увеличено: реальное разрешение останется ниже имени профиля.

Список имён можно вывести из корня проекта на компьютере, где установлен Node.js:

```bash
node - <<'NODE'
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('server/data/series_v2.json', 'utf8'));
const names = new Set();
function walk(value) {
  if (Array.isArray(value)) return value.forEach(walk);
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'video' || key === 'trailer') && typeof item === 'string') names.add(item);
    walk(item);
  }
}
walk(data);
console.log([...names].sort().join('\n'));
NODE
```

Учитывайте также медиа, которые код запрашивает прямо по имени, не через JSON: например, `choice_ambient.mp3`. Обложки и аудио этим FFmpeg-скриптом не создаются — их следует передать отдельно в `server/uploads/` с теми именами, которые использует проект.

---

## 4. DNS и подготовка домена

В DNS-панели домена создайте запись типа `A`:

```text
Имя: @
Значение: IPv4-адрес VPS
```

Для `www` создайте `CNAME` на основной домен либо отдельную запись `A` на тот же IP.

Если в DNS есть AAAA-запись, она должна указывать на рабочий IPv6 VPS. Неправильную AAAA-запись лучше удалить: часть посетителей иначе может подключаться не к тому серверу.

Проверить DNS можно с компьютера:

```bash
nslookup ВАШ-ДОМЕН.ru
```

---

## 5. Начальная настройка VPS

Подключитесь к серверу:

```bash
ssh root@IP-АДРЕС-VPS
```

Обновите пакеты и установите базовые инструменты:

```bash
apt update && apt upgrade -y
apt install -y git nginx curl ca-certificates rsync ffmpeg
```

Установите актуальную LTS-версию Node.js подходящим для вашей версии Ubuntu/Debian способом. После установки проверьте:

```bash
node -v
npm -v
which node
```

Запишите путь, выданный `which node`: он понадобится в systemd-конфигурации. Версия Node должна удовлетворять зависимостям проекта.

Создайте отдельного пользователя сервиса и каталог приложения:

```bash
adduser --system --group --home /var/www/za_kray zakray
mkdir -p /var/www/za_kray
chown -R zakray:zakray /var/www/za_kray
```

Клонируйте репозиторий. Если он публичный:

```bash
git clone https://github.com/breakskyprod/za_kray.git /var/www/za_kray
```

Если приватный — настройте SSH-ключ для Git или передайте проект другим безопасным способом. Не вставляйте GitHub-токен в публичные команды и файлы.

---

## 6. Настройка Node.js и секретов

Перейдите в папку сервера:

```bash
cd /var/www/za_kray/server
```

Установите зависимости. Если в репозитории есть `package-lock.json`, используйте:

```bash
npm ci --omit=dev
```

Иначе:

```bash
npm install --omit=dev
```

Создайте настоящий `.env` из шаблона:

```bash
cp .env.example .env
```

Сгенерируйте секретный ключ для приватной статистики:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Откройте файл:

```bash
nano /var/www/za_kray/server/.env
```

Пример настроек (подставьте свой домен и реальный ключ):

```env
PORT=3000
STATS_KEY=ВСТАВЬТЕ_ДЛИННЫЙ_СЛУЧАЙНЫЙ_КЛЮЧ
ALLOWED_ORIGINS=https://ВАШ-ДОМЕН.ru,https://www.ВАШ-ДОМЕН.ru
SERIES_FILE=series_v2.json
```

Домены в `ALLOWED_ORIGINS` указываются без завершающего `/`. Реальный `.env` не добавляйте в Git.

```bash
chmod 600 /var/www/za_kray/server/.env
```

Создайте необходимые каталоги и проверьте владельца:

```bash
mkdir -p /var/www/za_kray/server/data
mkdir -p /var/www/za_kray/server/uploads
chown -R zakray:zakray /var/www/za_kray/server/data
chown -R zakray:zakray /var/www/za_kray/server/uploads
```

Сначала запустите Node вручную для проверки:

```bash
cd /var/www/za_kray/server
sudo -u zakray npm start
```

Остановите тестовый процесс `Ctrl+C`, затем проверьте локальные API:

```bash
curl -i http://127.0.0.1:3000/api/series
curl -i http://127.0.0.1:3000/api/stats/public
```

Ожидается ответ `200` с JSON. Если сервер не запустился, проверьте вывод команды, `.env`, зависимости и корректность `series_v2.json`.

---

## 7. Передача больших видео на VPS

**Не загружайте видео в GitHub.** Для передачи удобны `rsync` по SSH или графический SFTP-клиент, например WinSCP.

На VPS создайте закрытую папку для исходников и временных файлов:

```bash
mkdir -p /srv/zakray/incoming
mkdir -p /srv/zakray/transcode/stage
chown -R zakray:zakray /srv/zakray
```

С компьютера, где находятся исходники, выполните:

```bash
rsync -avP "/локальный/путь/к/исходникам/" \
  root@IP-АДРЕС-VPS:/srv/zakray/incoming/
```

Замените локальный путь и IP. Если подключаетесь по SSH не под `root`, замените имя пользователя. `rsync -P` показывает прогресс и позволяет повторить передачу после обрыва.

В Windows можно открыть WinSCP, подключиться по SFTP и передать исходники в `/srv/zakray/incoming/`.

Проверьте файлы на VPS:

```bash
ls -lh /srv/zakray/incoming
du -sh /srv/zakray/incoming
```

Нужен запас дискового пространства: одновременно могут находиться исходники, готовые варианты качества и предыдущие версии файлов. Сначала проверьте доступное место:

```bash
df -h
```

---

## 8. Конвертация вариантов качества через FFmpeg

Проверьте, что FFmpeg установлен:

```bash
ffmpeg -version
ffmpeg -encoders | grep libx264
```

В репозитории должен находиться скрипт `deploy/transcode-all.sh`. Если его ещё нет, создайте файл с таким содержимым:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

IN="/srv/zakray/incoming"
OUT="/var/www/za_kray/server/uploads"
STAGE="/srv/zakray/transcode/stage"

mkdir -p "$OUT" "$STAGE"
shopt -s nullglob nocaseglob

encode() {
    local src="$1" stem="$2" label="$3"
    local max_w="$4" max_h="$5" maxrate="$6" bufsize="$7"
    local work="$STAGE/${stem}_work"
    mkdir -p "$work"

    echo "Кодирую $stem (${label}p)"
    ffmpeg -hide_banner -y -i "$src" \
        -map 0:v:0 -map '0:a:0?' -sn -dn \
        -vf "scale=w='min(${max_w},iw)':h='min(${max_h},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2" \
        -c:v libx264 -preset medium -crf 23 \
        -maxrate "$maxrate" -bufsize "$bufsize" \
        -pix_fmt yuv420p \
        -c:a aac -b:a 128k -ac 2 \
        -movflags +faststart \
        "$work/${stem}_${label}.mp4"
}

found=0
for src in "$IN"/*.mp4 "$IN"/*.mov "$IN"/*.mkv; do
    [[ -f "$src" ]] || continue
    found=1
    filename="$(basename "$src")"
    stem="${filename%.*}"
    work="$STAGE/${stem}_work"
    mkdir -p "$work"

    # Профили соответствуют именам, которые ищет frontend/player_v2.js.
    encode "$src" "$stem" 1080 1920 1080 5000k 10000k
    encode "$src" "$stem" 720 1280 720 2800k 5600k
    encode "$src" "$stem" 480 854 480 1400k 2800k
    encode "$src" "$stem" 360 640 360 800k 1600k

    # Публикуем варианты только после успешной генерации всех четырёх.
    for quality in 1080 720 480 360; do
        mv -f "$work/${stem}_${quality}.mp4" "$OUT/${stem}_${quality}.mp4"
    done

    # Базовое имя — запасной вариант, который тоже ожидает плеер.
    cp -f "$OUT/${stem}_720.mp4" "$work/${stem}.mp4"
    mv -f "$work/${stem}.mp4" "$OUT/${stem}.mp4"
    chmod 644 "$OUT/${stem}"*.mp4
    echo "Готово: $stem"
done

if [[ "$found" -eq 0 ]]; then
    echo "Не найдены MP4/MOV/MKV-файлы в $IN" >&2
    exit 1
fi

echo "Все исходники обработаны."
```

Перед запуском проверьте, что пути `IN`, `OUT` и `STAGE` соответствуют вашему серверу. Сделайте скрипт исполняемым и передайте исходники пользователю сервиса:

```bash
chmod +x /var/www/za_kray/deploy/transcode-all.sh
chown -R zakray:zakray /srv/zakray
chown -R zakray:zakray /var/www/za_kray/server/uploads
```

Запустите обработку:

```bash
sudo -u zakray /var/www/za_kray/deploy/transcode-all.sh
```

Если конвертация долгая, используйте `tmux`, чтобы она продолжалась после отключения SSH:

```bash
apt install -y tmux
tmux new -s zakray-transcode
sudo -u zakray /var/www/za_kray/deploy/transcode-all.sh
```

Отключиться от сессии, не завершая процесс: `Ctrl+B`, затем `D`. Вернуться:

```bash
tmux attach -t zakray-transcode
```

FFmpeg использует CPU и может работать долго. Сначала обработайте короткий тестовый файл, проверьте звук, картинку, разрешение и размер. Только после этого запускайте весь пакет.

### Имена выходных файлов

Для исходника `ep1_s1.mov` скрипт создаст:

```text
ep1_s1.mp4
ep1_s1_1080.mp4
ep1_s1_720.mp4
ep1_s1_480.mp4
ep1_s1_360.mp4
```

Имена исходников должны совпадать с базовыми именами в JSON. Например, если JSON ожидает `ep1_s1.mp4`, исходник называйте `ep1_s1.mov` или `ep1_s1.mp4`, а не `серия1-фрагмент1.mov`.

Скрипт предназначен для ландшафтного видео проекта. Он не увеличивает исходник до более высокого разрешения. Для аудио и обложек передавайте готовые файлы напрямую в `server/uploads/` через SFTP/rsync, сверяя их имена с кодом и JSON.

---

## 9. systemd: автозапуск Node.js

Откройте шаблон `deploy/zakray.service` и проверьте значения:

```ini
User=zakray
WorkingDirectory=/var/www/za_kray/server
ExecStart=/ПУТЬ/ИЗ/which/node app.js
```

Если шаблон содержит `User=www-data`, замените его на `zakray`. `ExecStart` должен использовать путь, который показала команда `which node`.

Установите unit-файл:

```bash
cp /var/www/za_kray/deploy/zakray.service /etc/systemd/system/zakray.service
nano /etc/systemd/system/zakray.service
systemctl daemon-reload
systemctl enable zakray
systemctl start zakray
systemctl status zakray
```

Логи сервиса:

```bash
journalctl -u zakray -n 100 --no-pager
journalctl -u zakray -f
```

После включения systemd не запускайте дополнительный Node-процесс вручную: для управления используйте `systemctl`.

---

## 10. Nginx: сайт, API и видео

Откройте `deploy/nginx.conf` и замените:

- `server_name` на домен проекта;
- путь в `alias` на реальный путь к `server/uploads`.

Важно: в Nginx-директива `alias` должна заканчиваться `/`, а путь в примере должен совпадать с фактической папкой. Шаблон раздаёт `/uploads/` прямо с диска и проксирует `/api/` на Node. Остальные страницы проксируются в Express, который раздаёт `frontend/`.

Установите конфиг:

```bash
cp /var/www/za_kray/deploy/nginx.conf /etc/nginx/sites-available/zakray
nano /etc/nginx/sites-available/zakray
ln -s /etc/nginx/sites-available/zakray /etc/nginx/sites-enabled/zakray
```

Если включён стандартный сайт Nginx и он мешает, отключите его:

```bash
rm -f /etc/nginx/sites-enabled/default
```

Проверьте синтаксис и перезагрузите Nginx:

```bash
nginx -t
systemctl reload nginx
```

`limit_req_zone` в шаблоне задаётся на уровне `http` и подходит для файла сайта, подключаемого из `sites-enabled` в стандартной конфигурации Debian/Ubuntu. Если конфигурация Nginx в вашей системе устроена иначе, перенесите `limit_req_zone` в контекст `http` в основном `nginx.conf`.

Проверьте, что пользователь Nginx может проходить по каталогам и читать видео. Для типовой установки:

```bash
chmod 755 /var/www
chmod 755 /var/www/za_kray
chmod 755 /var/www/za_kray/server
find /var/www/za_kray/server/uploads -type d -exec chmod 755 {} \;
find /var/www/za_kray/server/uploads -type f -exec chmod 644 {} \;
```

---

## 11. HTTPS и firewall

Когда DNS уже указывает на VPS и сайт доступен по HTTP, получите сертификат:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d ВАШ-ДОМЕН.ru -d www.ВАШ-ДОМЕН.ru
```

Если домен `www` не используется, уберите его из команды. Проверьте обновление сертификата:

```bash
certbot renew --dry-run
```

Откройте наружу SSH, HTTP и HTTPS. Порт Node `3000` публично открывать не нужно: к нему обращается локальный Nginx.

```bash
apt install -y ufw
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

Если у REG.RU отдельно настроены сетевые правила, разрешите там входящие подключения к портам `22`, `80`, `443`. Не открывайте `3000` для всего интернета.

---

## 12. Проверка после установки

API:

```bash
curl -i https://ВАШ-ДОМЕН.ru/api/series
curl -i https://ВАШ-ДОМЕН.ru/api/stats/public
```

Видео (замените имя на реально существующий файл):

```bash
curl -I https://ВАШ-ДОМЕН.ru/uploads/ep1_s1_720.mp4
```

Проверка перемотки/Range:

```bash
curl -i -H "Range: bytes=0-1023" \
  https://ВАШ-ДОМЕН.ru/uploads/ep1_s1_720.mp4
```

Для Range-запроса ожидается `206 Partial Content`. Затем проверьте в браузере на телефоне и компьютере:

- открытие главной страницы;
- проигрывание основного видео;
- перемотку;
- переходы по выборам и вставки бездействия;
- все варианты качества и режим «Авто»;
- загрузку и работу обложек и аудио;
- сохранение и восстановление прогресса.

Приватную статистику проверяйте заголовком, не помещая ключ в URL:

```bash
curl -H "Authorization: Bearer ВАШ_STАTS_KEY" \
  https://ВАШ-ДОМЕН.ru/api/stats
```

---

## 13. Бэкапы и устойчивость данных

Скрипт `deploy/backup.sh` делает архив каталога `server/data/`, но не видео. Проверьте в скрипте `PROJECT_DIR`, чтобы он совпадал с каталогом установки. Затем:

```bash
chmod +x /var/www/za_kray/deploy/backup.sh
sudo -u zakray /var/www/za_kray/deploy/backup.sh
ls -lh /var/www/za_kray/backups
```

Добавьте cron от подходящего пользователя:

```bash
crontab -e
```

Например, запуск ежедневно в 04:00:

```cron
0 4 * * * /var/www/za_kray/deploy/backup.sh >> /var/log/zakray_backup.log 2>&1
```

Архив на том же VPS не защищает от потери всего сервера. Копируйте бэкапы на отдельное хранилище/компьютер. Для исходных и готовых видео также храните отдельную копию.

JSON-файлы прогресса и статистики остаются простым хранилищем. Постоянный диск VPS не защищает от сбоя диска. При росте аудитории или требований к сохранности рассмотрите PostgreSQL и автоматические внешние бэкапы.

---

## 14. Обновление приложения

Сначала отправьте изменения в GitHub, затем на VPS:

```bash
cd /var/www/za_kray
git pull
cd /var/www/za_kray/server
npm ci --omit=dev
systemctl restart zakray
systemctl status zakray
```

Если нет `package-lock.json`, используйте `npm install --omit=dev` вместо `npm ci`.

`git pull` не переносит файлы, исключённые из Git: видео, `.env`, данные и бэкапы. Не удаляйте и не перезаписывайте эти каталоги при обновлении. Новые видео передавайте отдельно и запускайте FFmpeg для новых исходников.

Если изменились systemd- или Nginx-конфиги, скопируйте их в системные каталоги и примените изменения отдельно:

```bash
nginx -t && systemctl reload nginx
systemctl daemon-reload
systemctl restart zakray
```

---

## 15. Частые проблемы

### Сайт открывается, но видео возвращает 404

Проверьте имя файла в `series_v2.json`, наличие соответствующего файла в `server/uploads/`, путь `alias` в Nginx и завершающий `/` в `alias`.

### Видео есть, но Nginx возвращает 403

Проверьте права чтения файлов и право прохода пользователя Nginx через каждый родительский каталог. Nginx должен иметь доступ по пути `/var/www/za_kray/server/uploads/...`.

### API не открывается через домен

Проверьте Node:

```bash
systemctl status zakray
journalctl -u zakray -n 100 --no-pager
```

Проверьте Nginx:

```bash
nginx -t
systemctl status nginx
```

### Node не запускается после установки systemd

Проверьте `User`, `WorkingDirectory`, `ExecStart`, наличие `.env` и права чтения проекта. `ExecStart` должен указывать на правильный путь к Node.

### Перемотка не работает

Проверьте, что запрос Range возвращает `206 Partial Content`, а не `200`. Убедитесь, что Nginx действительно отдаёт файл напрямую из `uploads/`.

### После замены ролика зритель видит прежнее видео

Nginx может кэшировать ролики долго. Лучше публиковать обновлённое видео под новым именем и изменить ссылку в `series_v2.json`. Если имя сохранить прежним, очистите кэш браузера или скорректируйте Cache-Control.

---

## 16. Рекомендуемый порядок развёртывания

1. Проверить `series_v2.json` и составить список всех медиафайлов.
2. Настроить DNS на IP VPS.
3. Установить Node.js, Nginx, FFmpeg и базовые пакеты.
4. Клонировать репозиторий в `/var/www/za_kray`.
5. Настроить `server/.env`, зависимости и права на `data/`.
6. Запустить Node вручную и проверить API через `127.0.0.1:3000`.
7. Передать исходники через `rsync`/SFTP в `/srv/zakray/incoming`.
8. Сгенерировать профили FFmpeg и проверить имена, качество и звук.
9. Установить и запустить systemd-сервис.
10. Настроить Nginx для API, фронтенда и видео.
11. Проверить HTTP, Range-запросы и работу плеера.
12. Выпустить HTTPS-сертификат, настроить firewall и ежедневные бэкапы.
