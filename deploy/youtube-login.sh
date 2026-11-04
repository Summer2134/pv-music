#!/usr/bin/env bash
# Вход YouTube для PV Music через запасной Google-аккаунт (один раз). Под root: pv-music-youtube
# 1) включает OAuth, 2) перезапускает Lavalink, 3) показывает код для google.com/device,
# 4) ждёт входа, сам сохраняет refresh token в music/.env и перезапускает уже с ним.
set -uo pipefail
APP=/home/sanek/sanekbot/music
ENV=$APP/.env
[ "$(id -u)" = 0 ] || { echo "Запусти под root"; exit 1; }
put() { if grep -qE "^$1=" "$ENV"; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; else echo "$1=$2" >> "$ENV"; fi; }
put YOUTUBE_OAUTH true
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
echo "== Перезапускаю звук с входом в YouTube…"
bash "$APP/setup.sh" > /tmp/pv-music-setup.log 2>&1 || { echo "Установка упала, лог: /tmp/pv-music-setup.log"; exit 1; }
echo "== Жду код от YouTube (до 10 минут)…"
TOKEN=""
while read -r line; do
  if echo "$line" | grep -q "google.com/device"; then
    CODE=$(echo "$line" | grep -oE '[A-Z0-9]{3,4}-[A-Z0-9]{3,4}-[A-Z0-9]{3,4}' | head -1)
    echo
    echo "  1. Открой на телефоне или ПК:  https://www.google.com/device"
    echo "  2. Введи код:                  ${CODE:-(см. строку ниже)}"
    echo "  3. Войди ЗАПАСНЫМ аккаунтом и нажми «Разрешить»"
    [ -z "$CODE" ] && echo "     $line"
    echo
    echo "  Жду, пока войдёшь…"
  fi
  TOKEN=$(echo "$line" | grep -oE '1//[A-Za-z0-9_-]{20,}' | head -1)
  [ -n "$TOKEN" ] && break
done < <(timeout 600 journalctl -u lavalink -f --since "$SINCE" -o cat)
if [ -z "$TOKEN" ]; then echo "Код не пришёл или вход не завершён за 10 минут. Запусти ещё раз: pv-music-youtube"; exit 1; fi
put YOUTUBE_REFRESH_TOKEN "$TOKEN"
echo "== Вход выполнен, сохраняю и перезапускаю…"
bash "$APP/setup.sh" > /tmp/pv-music-setup.log 2>&1
echo "Готово ✅ YouTube подключён. Включи песню в Discord: /играть"
