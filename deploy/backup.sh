#!/usr/bin/env bash
# ===========================================
#  Бэкап данных проекта "За край"
#  Копирует data/ (статистика, прогресс, структура сериала).
#  Видео НЕ бэкапим этим скриптом — они большие и меняются редко
#  (для них делайте отдельную синхронизацию при заливке новых серий).
#
#  Установка в cron (ежедневно в 4:00):
#     crontab -e
#     0 4 * * * /var/www/za_kray/deploy/backup.sh >> /var/log/zakray_backup.log 2>&1
# ===========================================
set -euo pipefail

# --- Настройки (поправьте под свой сервер) ---
PROJECT_DIR="/var/www/za_kray"
DATA_DIR="$PROJECT_DIR/server/data"
BACKUP_DIR="$PROJECT_DIR/backups"
KEEP_DAYS=14   # сколько дней хранить бэкапы

# --- Логика ---
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y-%m-%d_%H-%M-%S)
ARCHIVE="$BACKUP_DIR/data_$STAMP.tar.gz"

tar -czf "$ARCHIVE" -C "$DATA_DIR" .
echo "[$(date)] Бэкап создан: $ARCHIVE"

# Удаляем бэкапы старше KEEP_DAYS дней
find "$BACKUP_DIR" -name 'data_*.tar.gz' -type f -mtime +"$KEEP_DAYS" -delete
echo "[$(date)] Старые бэкапы (> $KEEP_DAYS дней) очищены"
