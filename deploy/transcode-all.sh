#!/usr/bin/env bash
set -Eeuo pipefail

# Исходники (MP4/MOV/MKV) загружаются сюда по SFTP или rsync.
IN="/srv/zakray/incoming"
# Готовые файлы, которые выдаются через Nginx по /uploads/.
OUT="/var/www/za_kray/server/uploads"
# Временные файлы конвертации.
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

    # Профили соответствуют frontend/player_v2.js.
    encode "$src" "$stem" 1080 1920 1080 5000k 10000k
    encode "$src" "$stem" 720 1280 720 2800k 5600k
    encode "$src" "$stem" 480 854 480 1400k 2800k
    encode "$src" "$stem" 360 640 360 800k 1600k

    # Публикуем выходные варианты только после успешной генерации всех профилей.
    for quality in 1080 720 480 360; do
        mv -f "$work/${stem}_${quality}.mp4" "$OUT/${stem}_${quality}.mp4"
    done

    # Текущий плеер также пробует базовое имя как запасной вариант.
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
