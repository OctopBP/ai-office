/**
 * Свой агент офиса: контракт между формой «Создать агента» и сервером
 * (docs/design/custom-agent/spec.md, D-5 §4.1).
 *
 * Свой агент — пакет того же формата, что `packages/@office/*` (`agent.json`,
 * `brief/<язык>.md`, `skills/`), в области `@local`. Живёт в данных офиса,
 * рядом с его состоянием (решение владельца Q-206): в другой офис агент
 * попадает только публикацией в маркет, а правка доходит лишь до его копий в
 * этом офисе.
 */
import type { PermissionMode } from './types';
import type { ProviderId } from './providers';

/** Свой скил агента: `skills/<name>/SKILL.md` с front matter. */
export interface MyAgentSkill {
  /** Имя папки и скила: латиница, цифры, дефис. */
  name: string;
  /** «Когда применять» — по нему модель выбирает скил. */
  description: string;
  /** Текст инструкции без front matter. */
  text: string;
}

/**
 * Черновик своего агента из формы. Обязательны название и бриф, остальное
 * сервер добивает умолчаниями. В правке приходит частью: что прислали, то и
 * меняется.
 */
export interface MyAgentDraft {
  /**
   * Имя пакета без области: `boardgame-designer` → `@local/boardgame-designer`.
   * Пусто — сервер выводит из названия. После создания не меняется: на него
   * ссылаются нанятые копии.
   */
  id?: string;
  title: string;
  summary?: string;
  emoji?: string;
  /** `#rrggbb`. */
  color?: string;
  /** Внешность из `shared/looks.ts`; пусто — по цвету и id роли. */
  look?: string;
  /** Инструкции — `brief/<язык офиса>.md`. */
  brief: string;
  /** Движок. Пусто — Claude Code в пакете, а роль работает на выборе офиса. */
  engine?: ProviderId | null;
  /** Алиас (`opus`, `sonnet`, `haiku`) или точный id. Пусто — уровень офиса. */
  model?: string;
  /** null — режим доступа офиса. */
  permissionMode?: PermissionMode | null;
  /** true — работает с кодом в своей ветке; false — с документами в `docsDir`. */
  isolate?: boolean;
  /** Папка документов внутри проекта; пусто при `isolate: false` — `docs/<id>`. */
  docsDir?: string;
  /** Встроенные инструменты движка; null — все. Пустой список — ошибка. */
  tools?: string[] | null;
  /** Серверы MCP — id из каталога офиса. */
  mcp?: string[];
  /** Свои скилы. Нет поля в правке — скилы остаются прежними. */
  skills?: MyAgentSkill[];
  /** Встроенные скилы движка по имени. */
  builtin?: string[];
  /** Способности; пусто — офис выведет их сам. */
  capabilities?: string[];
  /**
   * Зона офиса, в которую агента нанимать. Хранится при агенте и
   * возвращается в ответе; сам найм — отдельная операция.
   */
  zone?: string | null;
}

/** Свой агент в списке: пакет, черновик для формы правки и кто нанят. */
export interface MyAgentView {
  /** Имя пакета: `@local/boardgame-designer`. */
  name: string;
  version: string;
  title: string;
  summary: string;
  emoji: string;
  color: string;
  /** Поля для формы правки — ровно то, что лежит в пакете. */
  draft: MyAgentDraft;
  /** Зона для найма — как прислали при создании или правке; null — не выбрана. */
  zone: string | null;
  /** Папка пакета в данных офиса. */
  dir: string;
  /** Роли этого офиса, нанятые из агента (без архивных). */
  roleIds: string[];
  /** Последняя публикация в маркет; null — агент живёт только в этом офисе. */
  published: MyAgentPublished | null;
  /** Замечания валидатора пакета (без ошибок — пакет с ошибкой в список не попадает). */
  warnings: string[];
}

/**
 * Публикация своего агента в маркет: под каким именем и версией он лежит в
 * реестре. Пакет в реестре — форк под областью владельца, а не `@local`.
 */
export interface MyAgentPublished {
  /** `@alice/boardgame-designer`. */
  name: string;
  version: string;
  /** Полный хеш коммита, на который смотрит запись реестра. */
  commit: string;
  /** Репозиторий на GitHub, `https://github.com/alice/agents.git`. */
  repo: string;
  /** Папка пакета в репозитории. */
  path: string;
  /** ISO-время публикации. */
  at: string;
  /** Куда вписали: файл реестра или адрес сервиса индекса. */
  registry: string;
}

/** Тело `POST /api/my-agents/<id>/publish`. */
export interface MyAgentPublishRequest {
  /** Имя в реестре: `@<владелец GitHub>/<имя>`. */
  name: string;
  /** Пусто — следующая patch после прошлой публикации, а впервые — версия пакета. */
  version?: string;
  /** Рабочая копия репозитория владельца на машине сервера; origin — на GitHub. */
  repoDir: string;
  /** Папка пакета в репозитории; пусто — `agents/<имя>`. */
  path?: string;
  /** Токен GitHub для сервиса индекса; пусто — `GITHUB_TOKEN` сервера. */
  token?: string;
}

/** Что сделали со своим агентом — приезжает в ответе, чтобы форма знала, на что ответ. */
export type MyAgentOp = 'create' | 'update' | 'from_role' | 'delete';
