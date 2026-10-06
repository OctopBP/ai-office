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
import { createDoc, docIndexForPrompt, listDocs, readDoc, setKind, updateDoc } from './docs';
import type { OfficeState } from './state';

const KIND = z.enum(['foundation', 'documentation', 'working']);

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

/** Строка оглавления: id, тип, задача, версия, название и описание. */
function line(state: OfficeState, d: DocMeta): string {
  const task = d.taskId ? `, ${d.taskId}` : '';
  const archived = d.archived ? `, ${state.say('tool.docs.archived')}` : '';
  const summary = d.summary ? ` — ${d.summary}` : '';
  return `- ${d.id} [${state.say(`docs.kind.${d.kind}`)}${task}, v${d.version}${archived}] ${d.title}${summary}`;
}

/**
 * Блок «Документы офиса» для системного промпта: оглавление без текстов.
 * Документов нет — пустая строка, и блока в промпте нет вовсе.
 */
export function docsBrief(state: OfficeState): string {
  try {
    const index = docIndexForPrompt(state);
    return index ? `\n\n${index}` : '';
  } catch {
    // Битая папка документов не должна ронять старт сессии.
    return '';
  }
}

/**
 * `author` — кто правит (id сотрудника или менеджера), `taskId` — задача
 * сессии: к ней привязывается рабочий материал, созданный без явного типа.
 */
export function docTools(state: OfficeState, author: string, taskId: string | null) {
  return [
    tool(
      'docs_list',
      state.say('tool.docsList.desc'),
      {
        kind: KIND.optional().describe(state.say('tool.docs.kind')),
        query: z.string().default('').describe(state.say('tool.docsList.query')),
        includeArchived: z.boolean().default(false).describe(state.say('tool.docsList.archived')),
      },
      async (args) => {
        const docs = listDocs(state, {
          kind: args.kind, query: args.query?.trim() || undefined, includeArchived: args.includeArchived,
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
      },
      async (args) => {
        const id = args.id?.trim() ?? '';
        try {
          if (id) {
            const doc = updateDoc(state, id, {
              title: args.title, summary: args.summary, body: args.body,
              ...(args.kind ? { kind: args.kind as DocKind } : {}),
            }, author);
            if (!doc) return text(state.say('tool.docs.notFound', { id }), true);
            return text(state.say('tool.docsWrite.updated', { id: doc.id, version: doc.version }));
          }
          // Без типа — рабочий материал текущей задачи: в документацию
          // переводят явно, когда ясно, что текст переживёт задачу.
          const kind: DocKind = args.kind ?? 'working';
          const doc = createDoc(state, {
            title: args.title, summary: args.summary, body: args.body, kind, author,
            ...(kind === 'working' && taskId ? { taskId } : {}),
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
