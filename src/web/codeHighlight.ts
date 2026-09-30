/**
 * Подсветка синтаксиса в блоках кода Markdown (Markdown.tsx).
 *
 * Свой разметчик на регулярках, а не highlight.js или prism: библиотеки
 * отдают HTML-строку, а её пришлось бы вставлять `dangerouslySetInnerHTML` —
 * ровно то, от чего Markdown.tsx отказался. Здесь на выходе список кусков
 * «класс + текст», и React рисует их обычными `<span>`, экранируя текст сам.
 * Разбор не грамматический: без вложенности и состояния, но для чтения кода
 * в чате и отчётах этого хватает, а бандл не растёт ни на байт зависимостей.
 */

/** Вид куска; класс в CSS — `hl-<вид>`, цвета в markdown.css. */
export type TokenKind =
  | 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'type' | 'title'
  | 'attr' | 'tag' | 'meta' | 'variable' | 'added' | 'deleted' | 'section' | 'strong';

export type Token = { kind: TokenKind | null; text: string };

/**
 * Правило: регулярка с флагом `y` (липкая — совпадение ровно с текущей
 * позиции) и вид куска. Функция вместо вида решает по совпадению: так слово
 * одним правилом делится на ключевое, литерал и просто имя.
 */
type Rule = [RegExp, TokenKind | null | ((m: RegExpExecArray) => TokenKind | null)];

const words = (list: string) => new Set(list.split(' '));

/** Слово целиком: иначе `format` подсветился бы как `for` + `mat`. */
function word(keywords: Set<string>, literals: Set<string>, types?: Set<string>): Rule {
  return [/[A-Za-z_$][\w$]*/y, (m) => {
    const w = m[0];
    if (keywords.has(w)) return 'keyword';
    if (literals.has(w)) return 'literal';
    if (types?.has(w)) return 'type';
    return null;
  }];
}

const NUMBER: Rule = [/\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b/y, 'number'];
const DQ: Rule = [/"(?:[^"\\\n]|\\.)*"?/y, 'string'];
const SQ: Rule = [/'(?:[^'\\\n]|\\.)*'?/y, 'string'];
/** `#` — комментарий только в начале строки или после пробела: в `a#b` и `$#` это не он. */
const HASH_COMMENT: Rule = [/(?<=^|\s)#.*/y, 'comment'];

const JS_KEYWORDS = words(
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends '
  + 'finally for from function get if implements import in infer instanceof interface is keyof let namespace new of '
  + 'private protected public readonly return satisfies set static super switch throw try type typeof var void while with yield',
);
const JS_LITERALS = words('true false null undefined NaN Infinity this');
const TS_TYPES = words('string number boolean any unknown never object symbol bigint');

const JS: Rule[] = [
  [/\/\/.*/y, 'comment'],
  [/\/\*[\s\S]*?(?:\*\/|$)/y, 'comment'],
  DQ, SQ,
  [/`(?:[^`\\]|\\[\s\S])*`?/y, 'string'],
  NUMBER,
  [/[A-Za-z_$][\w$]*(?=\s*\()/y, (m) => (JS_KEYWORDS.has(m[0]) ? 'keyword' : 'title')],
  [/[A-Z][\w$]*/y, (m) => (JS_LITERALS.has(m[0]) ? 'literal' : 'type')],
  word(JS_KEYWORDS, JS_LITERALS, TS_TYPES),
];

const JSON_RULES: Rule[] = [
  [/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, 'attr'],
  DQ,
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, 'number'],
  word(new Set(), words('true false null')),
];

const BASH_KEYWORDS = words('if then else elif fi for while until do done case esac in function select return exit export local readonly unset');
const BASH: Rule[] = [
  HASH_COMMENT,
  DQ, SQ,
  [/\$(?:\{[^}\n]*\}|\([^)\n]*\)|[\w@#?$!*-])/y, 'variable'],
  [/(?<=^|\s)--?[\w-]+/y, 'attr'],
  NUMBER,
  word(BASH_KEYWORDS, words('true false')),
];

const CSS: Rule[] = [
  [/\/\*[\s\S]*?(?:\*\/|$)/y, 'comment'],
  DQ, SQ,
  [/@[\w-]+/y, 'keyword'],
  [/#[\da-fA-F]{3,8}\b(?![\w-])/y, 'number'],
  [/-?\d*\.?\d+(?:%|[a-zA-Z]+)?/y, 'number'],
  [/--[\w-]+|[a-zA-Z-]+(?=\s*:[^:])/y, 'attr'],
  [/[.#][\w-]+/y, 'title'],
  [/::?[\w-]+/y, 'meta'],
  [/!important\b/y, 'keyword'],
  [/[a-zA-Z][\w-]*/y, null],
];

const HTML: Rule[] = [
  [/<!--[\s\S]*?(?:-->|$)/y, 'comment'],
  [/<!DOCTYPE[^>]*>/iy, 'meta'],
  [/<\/?[\w-]+|\/?>/y, 'tag'],
  [/[\w:-]+(?==)/y, 'attr'],
  DQ, SQ,
  [/&[#\w]+;/y, 'literal'],
];

const PY_KEYWORDS = words(
  'and as assert async await break class continue def del elif else except finally for from global if import in is '
  + 'lambda nonlocal not or pass raise return try while with yield match case',
);
const PY: Rule[] = [
  HASH_COMMENT,
  [/[rbfuRBFU]{0,2}("""|''')[\s\S]*?(?:\1|$)/y, 'string'],
  [/[rbfuRBFU]{1,2}(?=["'])/y, 'string'],
  DQ, SQ,
  [/@[\w.]+/y, 'meta'],
  NUMBER,
  [/(?<=\b(?:def|class)\s+)[A-Za-z_]\w*/y, 'title'],
  word(PY_KEYWORDS, words('True False None self')),
];

const DIFF: Rule[] = [
  [/^(?:diff |index |\+\+\+|---).*/my, 'section'],
  [/^@@.*/my, 'meta'],
  [/^\+.*/my, 'added'],
  [/^-.*/my, 'deleted'],
  [/.+/y, null],
];

const YAML: Rule[] = [
  HASH_COMMENT,
  [/^(?:---|\.\.\.)\s*$/my, 'meta'],
  [/[\w.-]+(?=\s*:(?:\s|$))/y, 'attr'],
  DQ, SQ,
  [/[&*][\w-]+/y, 'meta'],
  [/![\w!]+/y, 'type'],
  NUMBER,
  [/[A-Za-z_~][\w-]*|~/y, (m) => (/^(?:true|false|null|yes|no|on|off|~)$/i.test(m[0]) ? 'literal' : null)],
];

const MD: Rule[] = [
  [/^ {0,3}#{1,6}\s.*/my, 'section'],
  [/^ {0,3}>.*/my, 'comment'],
  [/^(?:`{3,}|~{3,}).*/my, 'meta'],
  [/^\s*(?:[-*+]|\d+[.)])(?=\s)/my, 'meta'],
  [/`[^`\n]+`/y, 'string'],
  [/\*\*[^*\n]+\*\*|__[^_\n]+__/y, 'strong'],
  [/!?\[[^\]\n]*\]\([^)\n]*\)/y, 'title'],
  [/[\p{L}\d_]+/uy, null],
];

const LANGS: Record<string, Rule[]> = {
  js: JS, jsx: JS, javascript: JS, mjs: JS, cjs: JS,
  ts: JS, tsx: JS, typescript: JS, mts: JS,
  json: JSON_RULES, jsonc: JSON_RULES, json5: JSON_RULES,
  bash: BASH, sh: BASH, shell: BASH, zsh: BASH, console: BASH, shellsession: BASH,
  css: CSS, scss: CSS,
  html: HTML, xml: HTML, svg: HTML, vue: HTML,
  python: PY, py: PY,
  diff: DIFF, patch: DIFF,
  yaml: YAML, yml: YAML,
  md: MD, markdown: MD,
};

/** Знаем ли язык из тега блока. */
export const knownLanguage = (lang: string): boolean => Object.hasOwn(LANGS, lang.toLowerCase());

/**
 * Разбить код на куски. Незнакомый язык — один кусок без вида: блок
 * покажется тем же оформлением, только без цвета. Склейка соседних
 * бесцветных кусков держит число `<span>` небольшим.
 */
export function highlight(code: string, lang: string): Token[] {
  if (!knownLanguage(lang)) return [{ kind: null, text: code }];
  const rules = LANGS[lang.toLowerCase()];
  const out: Token[] = [];
  const push = (kind: TokenKind | null, text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let pos = 0;
  outer: while (pos < code.length) {
    for (const [re, kind] of rules) {
      re.lastIndex = pos;
      const m = re.exec(code);
      if (!m || m[0].length === 0) continue;
      push(typeof kind === 'function' ? kind(m) : kind, m[0]);
      pos += m[0].length;
      continue outer;
    }
    push(null, code[pos]);
    pos++;
  }
  return out;
}
