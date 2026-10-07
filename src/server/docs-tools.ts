/**
 * Инструменты библиотеки документов (docs.ts) для сессий агентов: оглавление,
 * чтение, запись и смена типа. Одни и те же и у исполнителя, и у менеджера —
 * разница только в том, к какой задаче по умолчанию привязан новый рабочий
 * материал: у исполнителя это его задача, у менеджера задачи нет.
 *
 * Оглавление без текстов уже едет в системный промпт (`docsBrief`), поэтому
 * docs_list нужен для поиска и архива, а docs_read — чтобы прочитать целиком.
 */
import { z } from 'zod';
import type { DocKind, DocMeta } from '../shared/types';
import { tool } from './engines';
import {
  OFFICE_SCOPE, createDoc, docIndexForPrompt, docZoneLabel, listDocs, readDoc, setKind, updateDoc,
  type ListDocsQuery,
} from './docs';
import type { OfficeState } from './state';
import { sessionZone } from './rules';

const KIND = z.enum(['foundation', 'documentation', 'working']);

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

/** Строка оглавления: id, тип, задача, зона, версия, название и описание. */
function line(state: OfficeState, d: DocMeta): string {
  const task = d.taskId ? `, ${d.taskId}` : '';
  const zone = d.subprojectId ? `, ${docZoneLabel(state, d.subprojectId)}` : '';
  const archived = d.archived ? `, ${state.say('tool.docs.archived')}` : '';
  const summary = d.summary ? ` — ${d.summary}` : '';
  return `- ${d.id} [${state.say(`docs.kind.${d.kind}`)}${task}${zone}, v${d.version}${archived}] ${d.title}${summary}`;
}

/**
 * Блок «Документы офиса» для системного промпта: оглавление без текстов.
 * Документов нет — пустая строка, и блока в промпте нет вовсе.
 *
 * `zone` — зона сессии (docs/design/subprojects/spec.md §4.2): id — основа
 * офиса и документы этой зоны; null или undefined — оглавление целиком.
 */
export function docsBrief(state: OfficeState, zone?: string | null): string {
  try {
    const index = docIndexForPrompt(state, undefined, zone);
    return index ? `\n\n${index}` : '';
  } catch {
    // Битая папка документов не должна ронять старт сессии.
    return '';
  }
}

/** Роль автора: id сотрудника `backend#2` → роль `backend`. */
const roleOf = (state: OfficeState, author: string) => state.role(author.split('#')[0]);

/**
 * Почему автор не может менять документ этой области — или null, если может
 * (docs/design/subprojects/spec.md §4.2): «читать чужое можно, менять нельзя».
 * Менеджер и роли без закрепления правят всё; закреплённая роль — только
 * документы своих зон, а документ всего офиса (`zone` пуст) — нет.
 * Владельца через HTTP проверка не касается: она только у инструментов.
 */
export function docEditProblem(
  state: OfficeState, author: string, zone: string | undefined, id?: string,
): string | null {
  const role = roleOf(state, author);
  const own = role && !role.isManager ? role.subprojects ?? [] : [];
  if (!own.length || (zone && own.includes(zone))) return null;
  return state.say('tool.docs.foreignZone', {
    what: id ? state.say('tool.docs.what', { id }) : state.say('tool.docs.whatNew'), zone: zone ? docZoneLabel(state, zone) : state.say('tool.docs.officeZone'),
  });
}

/**
 * `author` — кто правит (id сотрудника или менеджера), `taskId` — задача
 * сессии: к ней привязывается рабочий материал, созданный без явного типа,
 * и от неё же берётся зона сессии (`sessionZone` из rules.ts).
 */
export function docTools(state: OfficeState, author: string, taskId: string | null) {
  // Зона задачи: задача есть — её зона (null — весь проект), нет — undefined,
  // и тогда rules.ts возьмёт единственную зону роли.
  const task = taskId ? state.tasks.get(taskId) : undefined;
  const zone = sessionZone(state, author.split('#')[0], task ? task.subprojectId ?? null : undefined);
  return [
    tool(
      'docs_list',
      state.say('tool.docsList.desc'),
      {
        kind: KIND.optional().describe(state.say('tool.docs.kind')),
        query: z.string().default('').describe(state.say('tool.docsList.query')),
        includeArchived: z.boolean().default(false).describe(state.say('tool.docsList.archived')),
        subproject: z.string().default('').describe(state.say('tool.docsList.subproject')),
      },
      async (args) => {
        // '' — своя зона и общее (без зоны сессии — всё), all — всё,
        // office — только общее, иначе — эта зона. Чужое читать можно.
        const want = args.subproject?.trim() ?? '';
        const scope: ListDocsQuery = want === 'all' ? {}
          : want ? { subprojectId: want }
          : zone ? { subprojectId: zone, withOffice: true } : {};
        const docs = listDocs(state, {
          kind: args.kind, query: args.query?.trim() || undefined, includeArchived: args.includeArchived, ...scope,
        });
        if (!docs.length) return text(state.say('tool.docsList.empty'));
        return text(docs.map((d) => line(state, d)).join('\n'));
      },
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'docs_read',
      state.say('tool.docsRead.desc'),
      {
        id: z.string().describe(state.say('tool.docs.id')),
        version: z.number().int().positive().optional().describe(state.say('tool.docsRead.version')),
      },
      async (args) => {
        const doc = readDoc(state, args.id.trim(), args.version);
        if (!doc) return text(state.say('tool.docs.notFound', { id: args.id }), true);
        return text(`${line(state, doc)}\n\n${doc.body}`);
      },
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'docs_write',
      state.say('tool.docsWrite.desc'),
      {
        id: z.string().default('').describe(state.say('tool.docsWrite.id')),
        title: z.string().describe(state.say('tool.docsWrite.title')),
        summary: z.string().describe(state.say('tool.docsWrite.summary')),
        body: z.string().describe(state.say('tool.docsWrite.body')),
        kind: KIND.optional().describe(state.say('tool.docs.kind')),
        subproject: z.string().default('').describe(state.say('tool.docsWrite.subproject')),
      },
      async (args) => {
        const id = args.id?.trim() ?? '';
        const want = args.subproject?.trim() ?? '';
        try {
          if (id) {
            const prev = readDoc(state, id);
            if (!prev) return text(state.say('tool.docs.notFound', { id }), true);
            const problem = docEditProblem(state, author, prev.subprojectId, id);
            // Перенос в другую область — правка и той области тоже.
            const moved = want ? (want === OFFICE_SCOPE ? undefined : want) : prev.subprojectId;
            const problemTo = moved !== prev.subprojectId ? docEditProblem(state, author, moved, id) : null;
            if (problem || problemTo) return text((problem ?? problemTo)!, true);
            const doc = updateDoc(state, id, {
              title: args.title, summary: args.summary, body: args.body,
              ...(args.kind ? { kind: args.kind as DocKind } : {}),
              ...(want ? { subprojectId: want } : {}),
            }, author);
            if (!doc) return text(state.say('tool.docs.notFound', { id }), true);
            return text(state.say('tool.docsWrite.updated', { id: doc.id, version: doc.version }));
          }
          // Без типа — рабочий материал текущей задачи: в документацию
          // переводят явно, когда ясно, что текст переживёт задачу.
          const kind: DocKind = args.kind ?? 'working';
          // Без явной области — зона сессии: рабочий материал наследует зону задачи.
          const area = want ? (want === OFFICE_SCOPE ? undefined : want) : zone ?? undefined;
          const problem = docEditProblem(state, author, area);
          if (problem) return text(problem, true);
          const doc = createDoc(state, {
            title: args.title, summary: args.summary, body: args.body, kind, author,
            ...(kind === 'working' && taskId ? { taskId } : {}),
            ...(area ? { subprojectId: area } : {}),
          });
          return text(state.say('tool.docsWrite.created', {
            id: doc.id, kind: state.say(`docs.kind.${doc.kind}`),
          }));
        } catch (err) {
          return text((err as Error).message, true);
        }
      },
    ),

    tool(
      'docs_set_kind',
      state.say('tool.docsSetKind.desc'),
      {
        id: z.string().describe(state.say('tool.docs.id')),
        kind: KIND.describe(state.say('tool.docs.kind')),
      },
      async (args) => {
        try {
          const prev = readDoc(state, args.id.trim());
          if (!prev) return text(state.say('tool.docs.notFound', { id: args.id }), true);
          const problem = docEditProblem(state, author, prev.subprojectId, prev.id);
          if (problem) return text(problem, true);
          const doc = setKind(state, args.id.trim(), args.kind, author);
          if (!doc) return text(state.say('tool.docs.notFound', { id: args.id }), true);
          return text(state.say('tool.docsSetKind.ok', {
            id: doc.id, kind: state.say(`docs.kind.${doc.kind}`),
          }));
        } catch (err) {
          return text((err as Error).message, true);
        }
      },
    ),
  ];
}
