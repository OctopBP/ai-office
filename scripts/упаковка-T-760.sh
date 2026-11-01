#!/bin/bash
# Штатная упаковка существующей T-760 по готовым блокам D-18 и T-779.
# Запуск: bash scripts/упаковка-T-760.sh /фактический/корень/репозитория
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  printf '%s\n' 'Укажите один аргумент: фактический корень репозитория.' >&2
  exit 1
fi
set -- "$(cd "$1" && pwd -P)"

mkdir -p "$HOME/Library/Application Support/AI Office/локальные-сборки/T-760"
cd "$HOME/Library/Application Support/AI Office/локальные-сборки/T-760"
cp "$HOME/Library/Application Support/AI Office/.office/worktrees/o-2/T-760/.tmp/T-760/локальная-поставка-main-e20c6ef.tar.gz" ./вход.tar.gz
printf '%s  %s\n' '738c8d2c234d60b14f68a91f6ff3218a9d539995afc26d438c5566466bbd9b27' 'вход.tar.gz' | shasum -a 256 -c -
tar -xzf вход.tar.gz

# Подстановка сервера T-779 после распаковки исходных входов D-18.
git -C "$1" merge-base --is-ancestor d01312021dcd8851bfa544b81d0c672d5bec93b4 main
git -C "$1" show main:docs/артефакты/сервер-main-d013120-T-776-T-768.mjs.gz > сервер-T-779.mjs.gz
printf '%s  %s\n' '8af14d5dd49b58432063921584222222fe6a5799d5562c113c8781262a4d59fd' 'сервер-T-779.mjs.gz' | shasum -a 256 -c -
printf '%s  %s\n' 'ea62c245b007916825e2deb732bc055592c9b4fa6071cffd401fbb5189e4cbd6' 'desktop/resources/server/index.mjs' | shasum -a 256 -c -
if [ ! -e desktop/resources/server/index.T-760-e20c6ef.mjs.saved ]; then
  cp -p desktop/resources/server/index.mjs desktop/resources/server/index.T-760-e20c6ef.mjs.saved
fi
printf '%s  %s\n' 'ea62c245b007916825e2deb732bc055592c9b4fa6071cffd401fbb5189e4cbd6' 'desktop/resources/server/index.T-760-e20c6ef.mjs.saved' | shasum -a 256 -c -
gzip -dc сервер-T-779.mjs.gz > desktop/resources/server/index.T-779.new.mjs
printf '%s  %s\n' '12860ef9461eb6281fafbde98905b1fb4ab7f827ccfa6261435baf848639af78' 'desktop/resources/server/index.T-779.new.mjs' | shasum -a 256 -c -
node --check desktop/resources/server/index.T-779.new.mjs
mv desktop/resources/server/index.T-779.new.mjs desktop/resources/server/index.mjs

mkdir -p кеш/npm кеш/electron кеш/builder
ELECTRON_CACHE="$PWD/кеш/electron" ELECTRON_BUILDER_CACHE="$PWD/кеш/builder" npm ci --prefix desktop --cache "$PWD/кеш/npm" --fetch-retries=0 --fetch-timeout=20000
ELECTRON_CACHE="$PWD/кеш/electron" ELECTRON_BUILDER_CACHE="$PWD/кеш/builder" npm --prefix desktop run dist -- --dir --mac --arm64 --publish never
