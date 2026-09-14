/**
 * Экспорт роли в пакет и заготовка пакета с нуля.
 *
 * Авторский путь по спеке (§7): человек собрал роль в форме офиса — модель,
 * инструменты, бриф, скилы в employees/<роль>/ — и жмёт «экспортировать в
 * пакет». Получает папку по формату packages/README.md с заполненным
 * манифестом; дальше git и PR в реестр. Форма роли и есть конструктор.
 *
 * Экспорт — всегда форк: бриф пишется целиком, как он вычислен (бриф пакета
 * плюс приписка), а не ссылкой на исходный пакет. Иначе пакет зависел бы от
 * другого пакета, а зависимостей между пакетами мы не заводим (спека §9).
 *
 * Та же заготовка (`scaffoldPackage`) делает и `office-agent init`: шаблон
 * пакета — это пустая роль, экспортированная в папку.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { LANGS, type Lang } from '../shared/i18n';
import { MODEL_ALIASES } from '../shared/models';
import type { McpServerDef } from '../shared/types';
import { t } from './i18n';
import {
  PACKAGE_NAME_RE, resolvePackage, validatePackage, type AgentManifest, type Localized, type PackageProblem,
} from './packages';
import type { Role } from './roles';
import { EMPLOYEES_DIR, readPackFields } from './skills';

/** Что нужно, чтобы собрать папку пакета. Всё, кроме имени, необязательно. */
export interface Scaffold {
  name: string;
  title: Localized;
  summary?: Localized;
  tags?: string[];
  color?: string;
  emoji?: string;
  look?: string;
  manager?: boolean;
  docsDir?: string;
  license?: string;
  runtime?: Partial<AgentManifest['runtime']>;
  skills?: string[];
  builtin?: string[];
  use?: string[];
  servers?: McpServerDef[];
  requires?: Partial<AgentManifest['requires']>;
  /** Брифы по языкам; пусто — файлов брифа не будет. */
  briefs?: Localized;
  /** Папка со скилами, которую скопировать в пакет целиком. */
  skillsFrom?: string;
  version?: string;
}

/** Полный id модели — в алиас, если он известен; иначе как есть. */
export function modelAlias(model: string): string {
  const found = (Object.entries(MODEL_ALIASES) as Array<[string, string]>).find(([, id]) => id === model);
  return found ? found[0] : model;
}

/** Последний сегмент имени: `@acme/lawyer` → `lawyer`. */
const shortName = (name: string): string => name.split('/').pop() ?? name;

/**
 * Собрать папку пакета. Папка должна быть новой или пустой: молча
 * перезаписать чужое нельзя. Возвращает замечания валидатора по тому, что
 * получилось, — пакет с ошибками сюда не попадёт: манифест пишем мы сами.
 */
export function scaffoldPackage(dir: string, spec: Scaffold): { problems: PackageProblem[] } {
  if (!PACKAGE_NAME_RE.test(spec.name)) throw new Error(`bad package name: ${spec.name}`);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`directory is not empty: ${dir}`);
  mkdirSync(resolve(dir, '.claude-plugin'), { recursive: true });

  const short = shortName(spec.name);
  const version = spec.version ?? '0.1.0';
  const title = Object.keys(spec.title).length ? spec.title : { en: short };
  const description = spec.summary?.en ?? spec.summary?.ru ?? title.en ?? title.ru ?? short;

  writeFileSync(resolve(dir, '.claude-plugin/plugin.json'), `${JSON.stringify({
    name: short, version, description,
  }, null, 2)}\n`);

  const manifest = {
    schema: 1,
    name: spec.name,
    kind: 'agent',
    title,
    ...(spec.summary && Object.keys(spec.summary).length ? { summary: spec.summary } : {}),
    tags: spec.tags ?? [],
    color: spec.color ?? '#94a3b8',
    emoji: spec.emoji ?? '🙂',
    ...(spec.look ? { look: spec.look } : {}),
    ...(spec.manager ? { manager: true } : {}),
    ...(spec.docsDir ? { docsDir: spec.docsDir } : {}),
    license: spec.license ?? '',
    runtime: {
      engine: 'claude-code',
      model: spec.runtime?.model ?? 'sonnet',
      ...(spec.runtime?.tools ? { tools: spec.runtime.tools } : {}),
      permissionMode: spec.runtime?.permissionMode ?? null,
      isolate: spec.runtime?.isolate ?? true,
      maxTurns: spec.runtime?.maxTurns ?? null,
      mcp: spec.runtime?.mcp ?? [],
    },
    ...(spec.skills?.length ? { skills: spec.skills } : {}),
    ...(spec.builtin?.length ? { builtin: spec.builtin } : {}),
    ...(spec.use?.length ? { use: spec.use } : {}),
    ...(spec.servers?.length ? { servers: spec.servers } : {}),
    requires: {
      office: spec.requires?.office ?? '',
      env: spec.requires?.env ?? [],
      network: spec.requires?.network ?? false,
    },
  };
  writeFileSync(resolve(dir, 'agent.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const briefs = spec.briefs ?? {};
  if (Object.values(briefs).some((b) => b && b.trim())) {
    mkdirSync(resolve(dir, 'brief'), { recursive: true });
    for (const lang of LANGS) {
      const text = briefs[lang]?.trim();
      if (text) writeFileSync(resolve(dir, `brief/${lang}.md`), `${text}\n`);
    }
  }
  if (spec.skillsFrom && existsSync(spec.skillsFrom)) {
    cpSync(spec.skillsFrom, resolve(dir, 'skills'), { recursive: true });
  }

  mkdirSync(resolve(dir, 'bench'), { recursive: true });
  writeFileSync(resolve(dir, 'bench/cases.json'), `${JSON.stringify({
    cases: [
      { what: 'describe a typical request for this role', prompt: 'Replace me with a real request.', expect: [], avoid: [] },
    ],
  }, null, 2)}\n`);
  writeFileSync(resolve(dir, 'README.md'), [
    `# ${title.en ?? title.ru ?? short}`,
    '',
    `Package \`${spec.name}\` for AI Office — an agent with a brief, model, tools and skills.`,
    '',
    '## Install',
    '',
    'Open the office → Agent market → “Add by link” and paste this repository URL',
    '(for a folder inside a repository: `owner/repo#path/to/package`).',
    '',
    '## Develop',
    '',
    '```',
    'office-agent validate .     # manifest, skills, secrets',
    'office-agent bench .        # do the skills trigger on typical requests (costs tokens)',
    'office-agent publish .      # registry entry for the current commit',
    '```',
    '',
    'Brief lives in `brief/<lang>.md`, skills in `skills/<name>/SKILL.md`, the manifest is `agent.json`.',
    'Versions are git tags: `' + `${short}@${version}` + '` for a package inside a repository, `v${version}` for a single-package one.',
    '',
  ].join('\n'));
  writeFileSync(resolve(dir, 'CHANGELOG.md'), `# Changelog\n\n## ${version}\n\n- First version.\n`);

  return { problems: validatePackage(dir) };
}

/**
 * Собрать заготовку пакета из роли офиса. Роль с пакетом отдаёт его скилы и
 * поля про серверы; роль без пакета — свой набор из employees/<id>/, если он
 * есть. Бриф — вычисленный, целиком: экспорт это форк.
 */
export function scaffoldFromRole(role: Role, name: string, lang: Lang, extra: Partial<Scaffold> = {}): Scaffold {
  const pkg = role.package ? resolvePackage(role.package) : null;
  const legacyDir = resolve(EMPLOYEES_DIR, role.id);
  const fields = pkg ? pkg.manifest : readPackFields(legacyDir);
  const skillsFrom = pkg ? resolve(pkg.dir, 'skills') : resolve(legacyDir, 'skills');
  return {
    name,
    title: { [lang]: role.title },
    ...(pkg ? { summary: pkg.manifest.summary, tags: pkg.manifest.tags } : {}),
    color: role.color,
    emoji: role.emoji,
    look: role.sprite ?? '',
    manager: role.isManager,
    docsDir: role.docsDir ?? '',
    license: pkg?.manifest.license ?? '',
    runtime: {
      model: modelAlias(role.model),
      tools: role.tools ?? null,
      permissionMode: role.permissionMode,
      isolate: role.isolate,
      maxTurns: role.maxTurns ?? null,
      mcp: role.mcp ?? [],
    },
    skills: fields.skills ?? [],
    builtin: fields.builtin ?? [],
    use: fields.use ?? [],
    servers: fields.servers ?? [],
    ...(pkg ? { requires: pkg.manifest.requires } : {}),
    briefs: { [lang]: role.brief },
    skillsFrom,
    ...extra,
  };
}

export type ExportResult =
  | { ok: true; dir: string; problems: PackageProblem[] }
  | { ok: false; error: string };

/**
 * Экспорт роли из офиса в папку. Путь — абсолютный или от директории проекта
 * офиса. Ошибки — готовым текстом на языке офиса: форма показывает их как есть.
 */
export function exportRole(role: Role, name: string, dir: string, projectDir: string, lang: Lang): ExportResult {
  const clean = name.trim();
  if (!PACKAGE_NAME_RE.test(clean)) return { ok: false, error: t(lang, 'export.badName', { name: clean }) };
  const target = isAbsolute(dir.trim()) ? resolve(dir.trim()) : resolve(projectDir, dir.trim() || `agents/${shortName(clean)}`);
  if (existsSync(target) && readdirSync(target).length) {
    return { ok: false, error: t(lang, 'export.dirTaken', { dir: target }) };
  }
  try {
    const { problems } = scaffoldPackage(target, scaffoldFromRole(role, clean, lang));
    return { ok: true, dir: target, problems };
  } catch (err) {
    return { ok: false, error: t(lang, 'export.failed', { error: (err as Error).message }) };
  }
}
