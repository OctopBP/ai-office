/**
 * Мост приложения для macOS и Windows — `window.officeDesktop`
 * (desktop/office-preload.js). В браузере его нет, и веб обязан жить без него.
 *
 * Контракт между главным процессом Electron и вебом, поэтому лежит в shared:
 * preload написан на JS и типов не видит, так что держит его в согласии
 * только этот файл — правите мост, правьте и здесь.
 */

import type { UpdateCommandResult, UpdateState } from './types';

/** Состояние и ответы обновления описаны в контракте types.ts — здесь только мост. */
export type { UpdateCommandResult, UpdatePhase, UpdateState } from './types';

/**
 * Обновление приложения (desktop/updater.js). Само приложение только
 * проверяет; скачать и перезапуститься — команды владельца из веба.
 */
export interface OfficeDesktopUpdates {
  /** Текущее состояние — для первого рисования и после перезагрузки окна. `busy` пересчитывается. */
  getState(): Promise<UpdateState>;
  /** Подписка на смену состояния, в том числе на смену `busy`; возвращает отписку. */
  onState(cb: (state: UpdateState) => void): () => void;
  /** Проверить сейчас. Ошибка приходит фазой `error`, а не исключением. */
  check(): Promise<UpdateState>;
  /** «Установить обновление»: начать загрузку из `available` (или повтор из `error` с версией). */
  download(): Promise<UpdateCommandResult>;
  /**
   * «Перезапустить сейчас»: поставить скачанное (`ready`) и перезапуститься.
   * Занятость не мешает — предупредить по `busy` должен веб до вызова.
   */
  restartNow(): Promise<UpdateCommandResult>;
}

export interface OfficeDesktop {
  /** Восстановить окно из свёрнутого и вывести на передний план. */
  focus(): void;
  /** Число того, что ждёт владельца: значок в доке, подсветка на панели задач. Ноль снимает. */
  setBadge(count: number): void;
  /** Обновление приложения. Нет поля — старая версия приложения без обновлений. */
  updates?: OfficeDesktopUpdates;
}
