/**
 * Есть ли в окне WebGL. Проверяется один раз и кэшируется: пробный холст на
 * каждую аватарку и каждый просмотр модели создавать незачем.
 *
 * Без WebGL холст R3F бросает исключение при создании контекста, и без
 * проверки оно роняет весь интерфейс, а не одну комнату: на слабой или
 * виртуальной видеокарте приложение показывало чёрное окно (T-187).
 */
let webglOk: boolean | null = null;

export function webglSupported(): boolean {
  if (webglOk !== null) return webglOk;
  try {
    const probe = document.createElement('canvas');
    webglOk = !!(probe.getContext('webgl2') || probe.getContext('webgl'));
  } catch {
    webglOk = false;
  }
  return webglOk;
}
