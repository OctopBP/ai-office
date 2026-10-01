/**
 * Блок «Результат» в карточке вопроса-согласования: где лежит то, что
 * владельца просят принять. Файлы читаются из работы задачи (`task`) — так
 * открывается и ветка, которую ещё не влили. Вопрос и «Жизнь офиса» рисуют
 * один и тот же блок, чтобы владелец видел результат везде одинаково.
 */
import { t } from '../i18n';
import { Icon, type IconName } from '../icons';
import { FileLink } from './FileLink';
import { resultEntries, type ResultFileGlyph } from './filePaths';

const GLYPH_ICON: Record<ResultFileGlyph, IconName> = {
  doc: 'file-text',
  image: 'photo',
  pdf: 'file-text',
  model: 'box',
  other: 'file',
};

export function ResultFiles({ files, task }: { files: readonly string[] | undefined; task: string | null }) {
  const entries = resultEntries(files);
  if (entries.length === 0) return null;
  return (
    <div className="result-files">
      <div className="result-files-title">{t('questionFiles.title')}</div>
      <div className="result-files-list">
        {entries.map((f) => (
          <FileLink key={f.path} fileRef={{ path: f.path }} task={task} title={f.path}
            className={f.main ? 'result-file is-main' : 'result-file'}>
            <Icon name={GLYPH_ICON[f.glyph]} size={16} className="result-file-icon" />
            <span className="result-file-name">{f.name}</span>
            {f.main && <span className="result-file-open">{t('questionFiles.openDoc')}</span>}
          </FileLink>
        ))}
      </div>
    </div>
  );
}
