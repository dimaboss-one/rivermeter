#!/bin/bash
# Сборка и публикация на GitHub Pages (ветка gh-pages). Свежий levels.json (его обновляет бот) переносится из текущего сайта.
set -e
cd "$(dirname "$0")/.."
npx vite build
curl -sf -m 30 https://dimaboss-one.github.io/rivermeter/data/levels.json -o dist/data/levels.json || rm -f dist/data/levels.json
cd dist
[ -d .git ] || { git init -q -b gh-pages; git remote add origin https://github.com/dimaboss-one/rivermeter.git; }
git add -A && git commit -qm "deploy" || true
git push -q -f origin gh-pages
