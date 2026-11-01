/** Адресная проверка на временных репозиториях, без живого офиса. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { commitAll, зафиксироватьДоработку, mergeBaseInto, mergeInProgress } from '../src/server/git';

for (const случай of ['индекс', 'коммит', 'метки', 'подготовленные метки', 'успех', 'совпадение с HEAD', 'пробелы']) {
  const каталог = mkdtempSync(resolve(tmpdir(), 'office-conflict-'));
  const git = (...аргументы: string[]) => execFileSync('git', аргументы, {
    cwd: каталог, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const файл = resolve(каталог, 'данные.txt');
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Проверка');
    git('config', 'user.email', 'test@local');
    writeFileSync(файл, 'основа\n');
    git('add', '.');
    git('commit', '-qm', 'Основа');
    git('checkout', '-qb', 'задача');
    writeFileSync(файл, 'задача\n');
    git('commit', '-qam', 'Задача');
    const до = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    writeFileSync(файл, 'база\n');
    git('commit', '-qam', 'База');
    git('checkout', '-q', 'задача');
    assert.equal((await mergeBaseInto(каталог, 'main', 'ru')).kind, 'conflict');
    assert.ok(git('ls-files', '-u'), 'Индекс действительно содержит конфликт');
    const содержимое = случай.includes('метки')
      ? readFileSync(файл, 'utf8')
      : случай === 'совпадение с HEAD' ? 'задача\n' : случай === 'пробелы' ? 'база  \nзадача\n' : 'база\nзадача\n';
    writeFileSync(файл, содержимое);
    if (случай === 'подготовленные метки') git('add', '.');
    if (случай === 'индекс') writeFileSync(resolve(каталог, '.git/index.lock'), '');
    if (случай === 'коммит') {
      git('config', 'core.hooksPath', resolve(каталог, '.git/hooks'));
      writeFileSync(resolve(каталог, '.git/hooks/pre-commit'), '#!/bin/sh\necho "Отказ коммита" >&2\nexit 1\n', { mode: 0o755 });
    }
    const результат = await зафиксироватьДоработку(каталог, 'Сохранение доработки');
    const успех = случай === 'успех' || случай === 'совпадение с HEAD' || случай === 'пробелы';
    assert.equal(результат.kind, успех ? 'committed' : 'failed', результат.message);
    assert.equal(readFileSync(файл, 'utf8'), содержимое, 'Доработка сохранена');
    if (успех) {
      assert.equal(await mergeInProgress(каталог), false);
      assert.equal(git('ls-files', '-u'), '');
      assert.equal(git('status', '--porcelain'), '');
      assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
      assert.equal(git('show', 'HEAD:данные.txt') + '\n', содержимое);
      assert.equal(await commitAll(каталог, 'Пусто'), 'empty');
    } else {
      assert.equal(git('rev-parse', 'HEAD'), до);
      assert.equal(await mergeInProgress(каталог), true);
      assert.match(результат.message, /git add|git commit|конфликтных меток/);
      if (случай === 'индекс') assert.ok(git('ls-files', '-u'));
      console.log(результат.message);
    }
    console.log('Пройдено:', случай);
  } finally {
    rmSync(каталог, { recursive: true, force: true });
  }
}
