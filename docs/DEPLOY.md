# Запуск PV Music

## 1. Приложение в Discord
1. https://discord.com/developers/applications → **New Application**.
2. **Bot** → **Reset Token** → скопировать токен. Для команд `!!!` включить **Message Content Intent** (без него музыка работает, `!!!` — нет).
3. **General Information** → скопировать **Application ID**.
4. Пригласить бота (подставить Application ID):
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=3238912`

## 2. Что нужно на сервере
- Node.js 22, PostgreSQL, ffmpeg;
- Java 17+ и [Lavalink v4](https://github.com/lavalink-devs/Lavalink) — звуковой движок, отдельная служба;
- необязательно: yt-dlp (запасной путь получения звука).

## 3. Запуск
```bash
cp .env.example .env      # заполнить токен, Application ID, базу, пароль Lavalink
npm ci && npm run build
npm start
```
Схема базы создаётся сама при старте (таблицы `music_*`).

## 4. Как это работает у меня
Бот живёт на своём VPS (Ubuntu 24.04, 1 ядро, 4 ГБ) рядом с основным PV Bot, под systemd:
- службы `lavalink` и `pv-music`, перед стартом `git pull` и `npm ci`;
- бот сам проверяет GitHub раз в 10 минут и перезапускается с новой версией, когда музыка нигде не играет;
- после перезапуска шлёт владельцу в ЛС «снова онлайн» и результат самопроверки звука.

Скрипт установки одной командой — [`deploy/setup.sh`](../deploy/setup.sh): Java, Lavalink, плагины, ffmpeg, yt-dlp, службы systemd. Он написан под раскладку моего сервера (бот лежит папкой `music/` внутри основного репозитория), пути в начале скрипта при необходимости поправить.
