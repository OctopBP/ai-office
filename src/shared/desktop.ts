/**
 * Мост приложения для macOS и Windows — `window.officeDesktop`
 * (desktop/office-preload.js). В браузере его нет, и веб обязан жить без него.
 *
 * Контракт между главным процессом Electron и вебом, поэтому лежит в shared:
 * preload написан на JS и типов не видит, так что держит его в согласии
 * только этот файл — правите мост, правьте и здесь.
 */

/**
 * Состояние автообновления (desktop/updater.js).
 *
 * `none` — обновлений нет или ещё не проверяли; `error` — последняя проверка
 * или загрузка не удалась (подробности в updates.log в папке данных). Уже
 * скачанное обновление ошибкой следующей проверки не отменяется: `ready`
 * остаётся до перезапуска.
 */
export type UpdateState =
  | { status: 'none' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  /** `percent` — целое от 0 до 100. */
  | { status: 'downloading'; version: string; percent: number }
  /** `notes` — описание релиза с GitHub, обычно HTML; бывает пустым. */
  | { status: 'ready'; version: string; notes: string }
  | { status: 'error'; message: string };

/**
 * Ответ на «поставить сейчас». При успехе приложение сразу закрывается и
 * перезапускается в новую версию. Отказ `busy` — в офисе идут задачи: работа
 * агентов не обрывается, а обновление ставится при выходе из приложения.
 */
export type UpdateInstallResult =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'not-ready'; message: string };

export interface OfficeDesktopUpdates {
  /** Текущее состояние — для первого рисования и после перезагрузки окна. */
  getState(): Promise<UpdateState>;
  /** Подписка на смену состояния; возвращает отписку. */
  onState(cb: (state: UpdateState) => void): () => void;
  /** Проверить сейчас. Ошибка приходит состоянием `error`, а не исключением. */
  check(): Promise<UpdateState>;
  /** Перезапуститься в скачанную версию, если в офисе никто не работает. */
  installNow(): Promise<UpdateInstallResult>;
}

export interface OfficeDesktop {
  /** Восстановить окно из свёрнутого и вывести на передний план. */
  focus(): void;
  /** Число того, что ждёт владельца: значок в доке, подсветка на панели задач. Ноль снимает. */
  setBadge(count: number): void;
  /** Автообновление. Нет поля — старая версия приложения без обновлений. */
  updates?: OfficeDesktopUpdates;
}
