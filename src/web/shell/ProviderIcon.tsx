import { PROVIDERS, isProviderId } from '../../shared/providers';

// Лучи «звёздочки» Claude: угол и длина. Разная длина — узнаваемая неровность знака.
const CLAUDE_RAYS: Array<[number, number]> = [
  [0, 11], [30, 9], [60, 11.5], [90, 10], [120, 11], [150, 9.5],
  [180, 11.5], [210, 9], [240, 11], [270, 10.5], [300, 9.5], [330, 11],
];

/**
 * Знак провайдера движка рядом с его названием. Инлайн-SVG, без зависимостей:
 * картинки из сети в десктоп-приложении без сети не покажутся.
 * Неизвестный провайдер — ничего не рисуем, подпись рядом остаётся сама по себе.
 */
export function ProviderIcon({ provider, size = 14 }: { provider?: string; size?: number }) {
  if (!isProviderId(provider)) return null;
  const common = {
    className: `provider-icon provider-icon-${provider}`,
    width: size, height: size, viewBox: '0 0 24 24',
    role: 'img', 'aria-label': PROVIDERS[provider].label,
  } as const;

  if (provider === 'claude-code') {
    return (
      <svg {...common}>
        <g transform="translate(12 12)" fill="currentColor">
          {CLAUDE_RAYS.map(([angle, length]) => (
            <rect key={angle} x={-1.1} y={-length} width={2.2} height={length} rx={1.1}
              transform={`rotate(${angle})`} />
          ))}
        </g>
      </svg>
    );
  }

  return (
    <svg {...common}>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="currentColor" />
      <path d="M7 8.5l3.5 3.5L7 15.5M12.5 16h4.5" fill="none" stroke="var(--surface)"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
