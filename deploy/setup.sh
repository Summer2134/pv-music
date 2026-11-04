#!/usr/bin/env bash
# Установка / обновление PV Music на VPS (Ubuntu). Запускать под root:
#   bash /home/sanek/sanekbot/music/setup.sh
# Повторный запуск безопасен: ничего не ломает, только обновляет Lavalink, плагины и настройки.
set -euo pipefail
BOT_USER=sanek
REPO=/home/$BOT_USER/sanekbot
APP=$REPO/music
LL=/home/$BOT_USER/lavalink
ENV=$APP/.env
[ "$(id -u)" = 0 ] || { echo "Запусти под root: sudo bash $0"; exit 1; }
[ -d "$APP" ] || { echo "Нет $APP — сначала обнови PV Bot (!!update), чтобы пришла папка music"; exit 1; }

# Сначала — свежий код с GitHub, и дальше выполняется уже НОВАЯ версия этого скрипта.
# package-lock.json раньше правился npm install, и git pull молча отказывал — бот перезапускался на старом коде.
if [ "${1:-}" != "--pulled" ]; then
  echo "== 0/6 Код с GitHub"
  sudo -u $BOT_USER git -C "$REPO" checkout -- music/package-lock.json 2>/dev/null || true
  if sudo -u $BOT_USER git -C "$REPO" pull --ff-only; then
    exec bash "$APP/setup.sh" --pulled
  fi
  echo
  echo "⚠️  Новый код НЕ скачался. Изменённые на сервере файлы:"
  sudo -u $BOT_USER git -C "$REPO" status --short --untracked-files=no | head -20
  echo "Сбросить их к версии с GitHub (.env и база не в git, не пострадают):"
  echo "  sudo -u $BOT_USER git -C $REPO reset --hard origin/main && pv-music-update"
  exit 1
fi
echo "Код: $(sudo -u $BOT_USER git -C "$REPO" log -1 --format='%h · %s')"

echo "== 1/6 Java"
if ! java -version 2>&1 | grep -qE 'version "(17|18|19|2[0-9])'; then
  apt-get update -qq && (apt-get install -y -qq openjdk-21-jre-headless || apt-get install -y -qq openjdk-17-jre-headless)
fi
java -version 2>&1 | head -1
# ffmpeg — перегоняет звук SoundCloud (HLS/AAC) в Ogg Opus для Lavalink.
command -v ffmpeg >/dev/null || { apt-get update -qq; apt-get install -y -qq ffmpeg; }
ffmpeg -version 2>&1 | head -1
# yt-dlp — запасной путь к звуку SoundCloud, если API отдаёт 404. Свежая версия с GitHub (пакет apt устаревший).
if ! command -v yt-dlp >/dev/null || [ "$(readlink -f "$(command -v yt-dlp)")" = /usr/local/bin/yt-dlp ]; then
  command -v python3 >/dev/null || apt-get install -y -qq python3
  curl -fsSL -o /usr/local/bin/yt-dlp.new https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && mv /usr/local/bin/yt-dlp.new /usr/local/bin/yt-dlp && chmod 755 /usr/local/bin/yt-dlp || echo "⚠️ yt-dlp не скачался (не страшно, это запасной путь)"
fi
yt-dlp --version 2>/dev/null | sed 's/^/yt-dlp /' || true

echo "== 2/6 Lavalink"
mkdir -p "$LL/plugins" "$LL/logs"
curl -fsSL -o "$LL/Lavalink.jar.new" https://github.com/lavalink-devs/Lavalink/releases/latest/download/Lavalink.jar
mv "$LL/Lavalink.jar.new" "$LL/Lavalink.jar"
latest() { curl -fsSL "https://maven.lavalink.dev/releases/$1/maven-metadata.xml" | grep -oP '(?<=<release>)[^<]+' | head -1; }
YT=$(latest dev/lavalink/youtube/youtube-plugin || true)
YT_SNAP=false
# Выпуск 1.18.2 не умеет TV-клиент YouTube (с августа 2026 «The page needs to be reloaded», issue #226) —
# берём свежую сборку из snapshots (там исправление b33460b). В music/.env: YOUTUBE_PLUGIN_VERSION=… — зафиксировать свою,
# YOUTUBE_PLUGIN_SNAPSHOT=false — вернуться на выпуск.
envget() { grep -E "^$1=" "$ENV" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }
PIN=$(envget YOUTUBE_PLUGIN_VERSION)
if [ -n "$PIN" ]; then YT=$PIN; [ "${#PIN}" -ge 7 ] && ! echo "$PIN" | grep -q '\.' && YT_SNAP=true
elif [ "$(envget YOUTUBE_PLUGIN_SNAPSHOT)" != "false" ]; then
  META=$(curl -fsSL https://maven.lavalink.dev/snapshots/dev/lavalink/youtube/youtube-plugin/maven-metadata.xml || true)
  SNAP=$(echo "$META" | grep -oP '(?<=<latest>)[^<]+' | head -1)
  [ -z "$SNAP" ] && SNAP=$(echo "$META" | grep -oP '(?<=<version>)[^<]+' | tail -1)
  if [ -n "$SNAP" ]; then YT=$SNAP; YT_SNAP=true; fi
fi
LS=$(latest com/github/topi314/lavasrc/lavasrc-plugin || true)
[ -n "$YT" ] && [ -n "$LS" ] || { echo "Не получилось узнать версии плагинов (maven.lavalink.dev недоступен?)"; exit 1; }
echo "youtube-plugin $YT ($( $YT_SNAP && echo 'свежая сборка' || echo 'выпуск' )) · lavasrc $LS"
# Старые версии плагинов убираем, иначе Lavalink грузит обе.
find "$LL/plugins" -name '*.jar' ! -name "*$YT*" ! -name "*$LS*" -delete 2>/dev/null || true

echo "== 3/6 Настройки (music/.env)"
touch "$ENV"; chmod 600 "$ENV"
get() { grep -E "^$1=" "$ENV" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
put() { if grep -qE "^$1=" "$ENV"; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; else echo "$1=$2" >> "$ENV"; fi; }
if [ -z "$(get MUSIC_TOKEN)" ]; then read -rp "Токен музыкального бота (Developer Portal → Bot → Reset Token): " T; put MUSIC_TOKEN "$T"; fi
if [ -z "$(get MUSIC_CLIENT_ID)" ]; then read -rp "Application ID музыкального бота (General Information): " T; put MUSIC_CLIENT_ID "$T"; fi
if [ -z "$(get MUSIC_OWNER_ID)" ]; then put MUSIC_OWNER_ID "$(grep -E '^SAY_USER_ID=' "$REPO/.env" | cut -d= -f2- | tr -d '"' || true)"; fi
if [ -z "$(get DATABASE_URL)" ]; then L=$(grep -E '^DATABASE_URL=' "$REPO/.env" | tail -1 || true); [ -n "$L" ] && echo "$L" >> "$ENV"; fi
if [ -z "$(get DATABASE_SSL)" ]; then L=$(grep -E '^DATABASE_SSL=' "$REPO/.env" | tail -1 || true); [ -n "$L" ] && echo "$L" >> "$ENV"; fi
[ -n "$(get LAVALINK_PASSWORD)" ] || put LAVALINK_PASSWORD "$(openssl rand -hex 16)"
on() { [ -n "$1" ] && echo true || echo false; }
SP_ID=$(get SPOTIFY_CLIENT_ID); SP_SEC=$(get SPOTIFY_CLIENT_SECRET); YA=$(get YANDEX_MUSIC_TOKEN); VK=$(get VK_MUSIC_TOKEN); YTR=$(get YOUTUBE_REFRESH_TOKEN); YTO=$(get YOUTUBE_OAUTH)
esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
sed -e "s|__PASSWORD__|$(esc "$(get LAVALINK_PASSWORD)")|" -e "s|__YT_VERSION__|$YT|" -e "s|__YT_SNAPSHOT__|$YT_SNAP|" -e "s|__LAVASRC_VERSION__|$LS|" \
    -e "s|__SPOTIFY_ON__|$( [ -n "$SP_ID" ] && [ -n "$SP_SEC" ] && echo true || echo false )|" -e "s|__SPOTIFY_ID__|$(esc "$SP_ID")|" -e "s|__SPOTIFY_SECRET__|$(esc "$SP_SEC")|" \
    -e "s|__YANDEX_ON__|$(on "$YA")|" -e "s|__YANDEX_TOKEN__|$(esc "$YA")|" -e "s|__VK_ON__|$(on "$VK")|" -e "s|__VK_TOKEN__|$(esc "$VK")|" \
    -e "s|__YT_OAUTH__|$( [ -n "$YTR" ] || [ "$YTO" = true ] && echo true || echo false )|" -e "s|__YT_REFRESH__|$(esc "$YTR")|" \
    "$APP/lavalink/application.template.yml" > "$LL/application.yml"
chown -R $BOT_USER:$BOT_USER "$LL" "$ENV"

echo "== 4/6 Службы"
NODE=$(command -v node); NPM=$(command -v npm); GIT=$(command -v git); JAVA=$(command -v java)
cat > /etc/systemd/system/lavalink.service <<UNIT
[Unit]
Description=Lavalink (звук для PV Music)
After=network-online.target
[Service]
User=$BOT_USER
WorkingDirectory=$LL
ExecStart=$JAVA -Xms128m -Xmx640m -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -jar $LL/Lavalink.jar
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/pv-music.service <<UNIT
[Unit]
Description=PV Music (музыкальный бот)
After=network-online.target lavalink.service postgresql.service
Wants=lavalink.service
[Service]
User=$BOT_USER
WorkingDirectory=$APP
ExecStartPre=-$GIT -C $REPO checkout -- music/package-lock.json
ExecStartPre=-$GIT -C $REPO pull --ff-only
ExecStartPre=$NPM ci --omit=dev --no-audit --no-fund
ExecStart=$NODE $APP/dist/index.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
cat > /usr/local/bin/pv-music-logs <<'S'
#!/bin/sh
journalctl -u pv-music -u lavalink -n 80 -f
S
cat > /usr/local/bin/pv-music-update <<S
#!/bin/sh
bash $APP/setup.sh
S
cat > /usr/local/bin/pv-music-youtube <<S
#!/bin/sh
bash $APP/youtube-login.sh
S
chmod +x /usr/local/bin/pv-music-logs /usr/local/bin/pv-music-update /usr/local/bin/pv-music-youtube

echo "== 5/6 Зависимости"
(cd "$APP" && sudo -u $BOT_USER $NPM ci --omit=dev --no-audit --no-fund)

echo "== 6/6 Запуск"
systemctl daemon-reload
systemctl enable -q lavalink pv-music
systemctl restart lavalink
sleep 8
systemctl restart pv-music
sleep 6
systemctl --no-pager --lines=0 status lavalink pv-music | grep -E 'Active|●' || true
echo
echo "Работает версия: $(sudo -u $BOT_USER git -C "$REPO" log -1 --format='%h · %s · %cd' --date=format-local:'%d.%m %H:%M')"
echo "Готово. Логи: pv-music-logs · обновить: pv-music-update (или !!!update в Discord)"
