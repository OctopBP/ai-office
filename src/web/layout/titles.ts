import { t } from '../i18n';
import type { WindowRef } from './model';

/** Заголовок вкладки окна. */
export function windowTitle(ref: WindowRef): string {
  const arg = ref.arg ?? '';
  switch (ref.kind) {
    case 'terminal': return arg ? t('terminal.tab', { n: arg }) : t('win.terminal');
    case 'docs': return t('win.docs');
    case 'log': return t('win.log');
    case 'money': return t('win.money');
    case 'merge': return t('win.merge');
    case 'meetings': return t('win.meetings');
    case 'diff': return t('win.diff', { arg });
    case 'agent': return t('win.agent', { arg });
    case 'task': return t('win.task', { arg });
  }
}
