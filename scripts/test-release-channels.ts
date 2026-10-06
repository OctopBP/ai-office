/**
 * Каналы выпуска: версии X.Y.Z-beta.N и поле channels у цели
 * (docs/design/release-channels/spec.md §4, §5.1). Чистые вычисления —
 * без git, без сервера и без моделей.
 *
 * Проверяется: цепочка 0.10.0 → 0.11.0-beta.1 → 0.11.0-beta.2 → 0.11.0;
 * таблица §4.2; порядок пререлизов; стабильный счёт не берёт беты; старая
 * цель без channels разбирается как раньше; запреты разбора каналов.
 *
 * Запуск: npm run test:channels
 */
import {
  compareVersions, latestStable, nextChannelVersion, parseReleaseConfig, targetChannels, versionInAnswer,
  type ReleaseTarget,
} from '../src/shared/release';

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  const line = `  ${ok ? '✅' : '❌'} ${what}: ${ok}`;
  results.push(line);
  console.log(line);
};
const say = (text: string) => { results.push(text); console.log(text); };

/** Разбор бросает ошибку — и в её тексте есть нужный кусок. */
const rejects = (what: string, data: unknown, part: string) => {
  try {
    parseReleaseConfig(data, {});
    check(what, false);
  } catch (err) {
    check(what, String((err as Error).message).includes(part));
  }
};

say('Цепочка версий: 0.10.0 → бета → бета → стабильный');
{
  // Теги как в git по шаблону v{version}: версия без «v».
  const tags = ['0.9.0', '0.10.0'];
  const b1 = nextChannelVersion({ versions: tags, channel: 'beta', level: 'minor' });
  check('первая бета 0.11.0-beta.1', b1 === '0.11.0-beta.1');
  tags.push(b1);
  // Следующая бета того же цикла — даже с разрядом patch цикл не дробится.
  const b2 = nextChannelVersion({ versions: tags, channel: 'beta', level: 'patch' });
  check('вторая бета 0.11.0-beta.2', b2 === '0.11.0-beta.2');
  tags.push(b2);
  check('тег беты v{version}', `v${b2}` === 'v0.11.0-beta.2');
  const stable = nextChannelVersion({ versions: tags, channel: 'stable', level: 'minor', fromBeta: b2 });
  check('стабильный из беты 0.11.0', stable === '0.11.0');
  tags.push(stable);
  // Стабильный без беты считает от стабильного, а не от пререлиза.
  check('стабильный без беты 0.12.0', nextChannelVersion({ versions: tags, channel: 'stable', level: 'minor' }) === '0.12.0');
  check('после стабильного бета открывает новый цикл', nextChannelVersion({ versions: tags, channel: 'beta', level: 'minor' }) === '0.12.0-beta.1');
}

say('Таблица §4.2 (S = 1.4.2)');
{
  const S = ['1.4.2'];
  check('пререлизов нет, minor → 1.5.0-beta.1', nextChannelVersion({ versions: S, channel: 'beta', level: 'minor' }) === '1.5.0-beta.1');
  const open = [...S, '1.5.0-beta.1', '1.5.0-beta.2'];
  check('major переоткрывает цикл → 2.0.0-beta.1', nextChannelVersion({ versions: open, channel: 'beta', level: 'major' }) === '2.0.0-beta.1');
  check('у альфы свой счёт → 1.5.0-alpha.1', nextChannelVersion({ versions: open, channel: 'alpha', level: 'patch' }) === '1.5.0-alpha.1');
  check('версия плана — база → 1.6.0-beta.1', nextChannelVersion({ versions: open, channel: 'beta', level: 'patch', planVersion: '1.6.0' }) === '1.6.0-beta.1');
  check('хотфикс → 1.4.3', nextChannelVersion({ versions: open, channel: 'stable', level: 'minor', hotfix: true }) === '1.4.3');
  // N — от старшего тега канала, а не от их количества.
  check('N от старшего тега → 1.5.0-beta.8', nextChannelVersion({ versions: [...S, '1.5.0-beta.7', '1.5.0-beta.2'], channel: 'beta', level: 'patch' }) === '1.5.0-beta.8');
  check('первый выпуск вообще → 0.1.0-beta.1', nextChannelVersion({ versions: [], channel: 'beta', level: 'minor' }) === '0.1.0-beta.1');
}

say('Порядок версий');
{
  const sorted = ['1.5.0', '1.5.0-beta.2', '1.4.2', '1.5.0-alpha.3', '1.5.0-beta.10', '1.5.0-beta.1']
    .sort(compareVersions);
  check('alpha < beta.1 < beta.2 < beta.10 < стабильный',
    sorted.join(' ') === '1.4.2 1.5.0-alpha.3 1.5.0-beta.1 1.5.0-beta.2 1.5.0-beta.10 1.5.0');
  check('старшая стабильная не берёт бету', latestStable(['1.4.2', '1.5.0-beta.3']) === '1.4.2');
  check('ответ владельца с пререлизом', versionInAnswer('выпускай 1.5.0-beta.2') === '1.5.0-beta.2');
  check('ответ владельца со стабильной', versionInAnswer('выпускай 2.0.0, пожалуйста') === '2.0.0');
}

say('Поле channels у цели');
{
  const old: Record<string, unknown> = {
    id: 'desktop', title: 'Приложение', kind: 'tag', tag: 'v{version}',
    policy: { when: ['manual'], approve: 'always' },
    version: { scheme: 'semver', level: 'plan', source: 'tag' },
  };
  const parsedOld = parseReleaseConfig({ targets: [old] }, {}).targets[0] as ReleaseTarget;
  check('старая цель без channels разбирается', !parsedOld.channels && targetChannels(parsedOld).length === 0);

  const withChannels = {
    ...old,
    channels: {
      stable: { branch: 'release', assets: ['latest-mac.yml'] },
      beta: { branch: 'beta', assets: ['beta-mac.yml'] },
    },
  };
  const parsed = parseReleaseConfig({ targets: [withChannels] }, {}).targets[0] as ReleaseTarget;
  check('цель с каналами stable и beta', targetChannels(parsed).join(',') === 'stable,beta');

  rejects('каналы только у тега', { targets: [{ ...withChannels, kind: 'push', branch: 'deploy', tag: undefined }] }, 'только у тега');
  rejects('каналы только у semver', { targets: [{ ...withChannels, version: { scheme: 'calver', level: 'auto' } }] }, 'semver');
  rejects('ветка канала не main', { targets: [{ ...withChannels, channels: { stable: { branch: 'main' } } }] }, 'не может быть основной');
  rejects('ветки каналов разные', { targets: [{ ...withChannels, channels: { stable: { branch: 'rel' }, beta: { branch: 'rel' } } }] }, 'одна ветка');
  rejects('стабильный продвигается из беты, если она есть',
    { targets: [{ ...withChannels, channels: { stable: { branch: 'release', from: 'main' }, beta: { branch: 'beta' } } }] }, 'из беты');
}

const failed = results.filter((l) => l.includes('❌')).length;
console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ все проверки каналов выпуска прошли');
process.exit(failed ? 1 : 0);
