/**
 * Отвязать проверку от приложения офиса. Импортируется ПЕРВЫМ в скрипте
 * проверки: `root.ts` и `store.ts` читают окружение на импорте, и строка ниже
 * любого другого импорта опоздала бы.
 *
 * Проверку запускают и руками, и сессией исполнителя, и гейтом сервера,
 * который сам мог быть запущен из /Applications/AI Office.app. Сервер чистит
 * окружение детей (`projectEnv`), но проверка не должна на это полагаться:
 * с унаследованными OFFICE_ROOT и OFFICE_STATE_FILE она читала раскладки из
 * .app и писала состояние в настоящий офис владельца (T-109).
 *
 * Корень — рабочая копия (без OFFICE_ROOT его считает root.ts от исходников),
 * состояние — своя временная папка, удаляется на выходе.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { stripAppVars } from '../src/server/childenv';

stripAppVars(process.env);

const dir = mkdtempSync(resolve(tmpdir(), 'office-check-'));
process.env.OFFICE_STATE_FILE = resolve(dir, 'state.json');
process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка — не беда */ }
});
