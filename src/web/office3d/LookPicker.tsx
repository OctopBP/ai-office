/**
 * Выбор внешности агента в форме роли.
 *
 * Пока — плитки-заглушки с первой буквой названия: превью трёхмерной моделью
 * (каждая карточка — свой маленький холст с живой фигурой) отложено вместе с
 * портретами в `AgentAvatar.tsx`, пока общий холст ломается при монтировании.
 * Вариантов ровно столько, сколько скинов у персонажа (`LOOKS`): выбранный
 * здесь человечек — тот же, что встанет в комнате. Подписи — из того же
 * списка (`looks.json`), а не из словаря интерфейса: их заводят вместе со
 * скином на стенде.
 */
import { LOOKS, lookTitle } from '../../shared/looks';
import { lang } from '../i18n';

export function LookPicker({ value, onPick }: {
  value: string | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <div className="look-grid">
      {LOOKS.map((look) => {
        const label = lookTitle(look, lang());
        return (
          <button
            key={look.id} type="button"
            className={`look-swatch ${value === look.id ? 'on' : ''}`}
            title={label} onClick={() => onPick(look.id)}
          >
            <span className="look-ph">{label.slice(0, 1).toUpperCase()}</span>
            <span className="look-name">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
