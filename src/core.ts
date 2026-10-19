import { createHash } from 'node:crypto';
export const TYPES = ['TODO', 'FIXME', 'BUG'] as const;
export const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'] as const;
export const STATUSES = ['open', 'inProgress', 'done', 'deferred'] as const;
export type TaskType = typeof TYPES[number];
export type Priority = typeof PRIORITIES[number];
export type Status = typeof STATUSES[number];
export const STATUS_LABELS: Record<Status, string> = { open: 'Открыта', inProgress: 'В работе', done: 'Выполнено', deferred: 'Отложено' };
export interface Syntax { line?: string[]; block?: [string, string][] }
export interface Task {
  uri: string; sourceHash: string; type: TaskType; priority: Priority; description: string;
  id?: string; line: number; column: number; start: number; end: number; markerEnd: number;
  commentStart: number; commentEnd: number; contentStart: number; contentEnd: number;
}
const cStyle: Syntax = { line: ['//'], block: [['/*', '*/']] };
const hashStyle: Syntax = { line: ['#'] };
export const SYNTAX: Record<string, Syntax> = {
  javascript: cStyle, javascriptreact: cStyle, typescript: cStyle, typescriptreact: cStyle,
  c: cStyle, cpp: cStyle, csharp: cStyle, java: cStyle, go: cStyle, rust: cStyle,
  swift: cStyle, kotlin: cStyle, dart: cStyle, php: { line: ['//', '#'], block: [['/*', '*/']] },
  css: { block: [['/*', '*/']] }, scss: cStyle, less: cStyle, jsonc: cStyle,
  python: hashStyle, ruby: hashStyle, shellscript: hashStyle, yaml: hashStyle,
  r: hashStyle, perl: hashStyle, powershell: { line: ['#'], block: [['<#', '#>']] },
  html: { block: [['<!--', '-->']] }, xml: { block: [['<!--', '-->']] },
  vue: { block: [['<!--', '-->']] }, svelte: { block: [['<!--', '-->']] },
  sql: { line: ['--'], block: [['/*', '*/']] }, lua: { line: ['--'], block: [['--[[', ']]']] },
  haskell: { line: ['--'], block: [['{-', '-}']] }, ini: { line: [';', '#'] },
  dockerfile: hashStyle, makefile: hashStyle, toml: hashStyle,
  bat: { line: ['REM ', 'rem ', '::'] }, latex: { line: ['%'] }
};
const EXTENSIONS: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  ts: 'typescript', tsx: 'typescriptreact', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', java: 'java', go: 'go', rs: 'rust', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  dart: 'dart', php: 'php', css: 'css', scss: 'scss', less: 'less', jsonc: 'jsonc',
  py: 'python', rb: 'ruby', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  yml: 'yaml', yaml: 'yaml', r: 'r', pl: 'perl', ps1: 'powershell',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml', vue: 'vue', svelte: 'svelte',
  sql: 'sql', lua: 'lua', hs: 'haskell', ini: 'ini', toml: 'toml', bat: 'bat', cmd: 'bat', tex: 'latex'
};
export function languageForPath(path: string): string {
  const file = path.split('/').pop()!.toLowerCase();
  if (file === 'dockerfile') { return 'dockerfile'; }
  if (file === 'makefile') { return 'makefile'; }
  return EXTENSIONS[file.split('.').pop()!] ?? '';
}
interface Comment { start: number; end: number; contentStart: number; contentEnd: number }
/** Conservative lexical scanner: ignores quoted text, including multiline strings/templates. */
function comments(text: string, syntax: Syntax, language: string): Comment[] {
  const result: Comment[] = [];
  const markup = ['html', 'xml', 'vue', 'svelte'].includes(language);
  let i = 0;
  let inTag = false;
  while (i < text.length) {
    const block = syntax.block?.find(([open]) => open && text.startsWith(open, i));
    if (block) {
      const close = text.indexOf(block[1], i + block[0].length);
      const end = close < 0 ? text.length : close + block[1].length;
      result.push({ start: i, end, contentStart: i + block[0].length, contentEnd: close < 0 ? text.length : close });
      i = end; continue;
    }
    const line = syntax.line?.find(open => open && text.startsWith(open, i));
    if (line) {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : (text[nl - 1] === '\r' ? nl - 1 : nl);
      result.push({ start: i, end, contentStart: i + line.length, contentEnd: end });
      i = nl < 0 ? text.length : nl + 1; continue;
    }
    if (markup && text[i] === '<') { inTag = true; }
    if (markup && text[i] === '>') { inTag = false; }
    // Regex literals can contain quote and comment characters. Distinguish common
    // expression starts from division; this remains a lightweight lexical scanner.
    if (['javascript', 'javascriptreact', 'typescript', 'typescriptreact'].includes(language) && text[i] === '/') {
      const prefix = text.slice(Math.max(0, i - 100), i).trimEnd();
      if (!prefix || /[=([{,:;!?&|]$/.test(prefix) || /\b(return|throw|yield|case)\s*$/.test(prefix)) {
        let j = i + 1, inClass = false;
        while (j < text.length && text[j] !== '\n') {
          if (text[j] === '\\') { j += 2; continue; }
          if (text[j] === '[') { inClass = true; }
          if (text[j] === ']') { inClass = false; }
          if (text[j] === '/' && !inClass) { i = j + 1; break; }
          j++;
        }
        if (i === j + 1) { continue; }
      }
    }
    // Apostrophes in markup prose are text; quoted tag attributes are strings.
    if ((!markup || inTag) && ('\'"`'.includes(text[i]))) {
      const quote = text[i];
      const triple = (language === 'python') && text.startsWith(quote.repeat(3), i);
      const delimiter = triple ? quote.repeat(3) : quote;
      i += delimiter.length;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text.startsWith(delimiter, i)) { i += delimiter.length; break; }
        // Single quotes cannot cross lines in these common languages.
        if (!triple && quote !== '`' && text[i] === '\n' && !['ruby', 'shellscript', 'sql'].includes(language)) { i++; break; }
        i++;
      }
      continue;
    }
    i++;
  }
  return result;
}
export function parseTasks(text: string, uri: string, language: string, syntax = SYNTAX[language]): Task[] {
  if (!syntax || text.includes('\0')) { return []; }
  const tasks: Task[] = [];
  const sourceHash = createHash('sha256').update(text).digest('hex');
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) { if (text[i] === '\n') { lineStarts.push(i + 1); } }
  function position(offset: number) {
    let lo = 0, hi = lineStarts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid; } }
    return { line: lo, column: offset - lineStarts[lo] };
  }
  for (const comment of comments(text, syntax, language)) {
    const body = text.slice(comment.contentStart, comment.contentEnd);
    const marker = /\b(TODO|FIXME|BUG)(?:\[(CRITICAL|HIGH|MEDIUM|LOW)\])?(?=\s|:|$)/g;
    const matches = [...body.matchAll(marker)];
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const start = comment.contentStart + match.index!;
      const newline = text.indexOf('\n', start);
      let end = Math.min(comment.contentEnd, newline < 0 ? text.length : newline, i + 1 < matches.length ? comment.contentStart + matches[i + 1].index! : text.length);
      while (end > start && /\s/.test(text[end - 1])) { end--; }
      const raw = text.slice(start + match[0].length, end).replace(/^\s*:\s*/, '').trim();
      const idMatch = raw.match(/\s*\{#todo:([a-zA-Z0-9-]{8,80})\}/);
      const description = raw.replace(/\s*\{#todo:[a-zA-Z0-9-]{8,80}\}/g, '').trim();
      tasks.push({ uri, sourceHash, type: match[1] as TaskType, priority: (match[2] ?? 'NONE') as Priority, description,
        id: idMatch?.[1], start, end, markerEnd: start + match[0].length, ...position(start), commentStart: comment.start,
        commentEnd: comment.end, contentStart: comment.contentStart, contentEnd: comment.contentEnd });
    }
  }
  return tasks;
}
export function taskText(type: TaskType, priority: Priority, description: string, id?: string): string {
  return `${type}${priority === 'NONE' ? '' : `[${priority}]`}: ${description}${id ? ` {#todo:${id}}` : ''}`;
}
export function wrapComment(content: string, syntax: Syntax): string {
  if (syntax.line?.length) { return `${syntax.line[0]} ${content}`; }
  if (syntax.block?.length) { return `${syntax.block[0][0]} ${content} ${syntax.block[0][1]}`; }
  throw new Error('Для языка не настроен синтаксис комментариев.');
}
export function validDescription(value: string, syntax: Syntax): string | undefined {
  if (!value.trim()) { return 'Введите описание задачи.'; }
  if (/[\r\n]/.test(value)) { return 'Описание должно занимать одну строку.'; }
  if (/\{#todo:/.test(value)) { return 'Служебный идентификатор добавляется автоматически.'; }
  if (/\b(TODO|FIXME|BUG)(?:\[[A-Z]+\])?(?=\s|:|$)/.test(value)) { return 'Описание не должно содержать дополнительный маркер задачи.'; }
  if (syntax.block?.some(([, close]) => value.includes(close))) { return 'Описание содержит закрывающий разделитель комментария.'; }
  return undefined;
}
export interface ViewOptions { query: string; types: TaskType[]; priorities: Priority[]; statuses: Status[]; group: 'file' | 'type' | 'priority' | 'status' | 'none'; sort: 'priority' | 'location' | 'type' | 'description' }
export const DEFAULT_OPTIONS: ViewOptions = { query: '', types: [], priorities: [], statuses: [], group: 'file', sort: 'priority' };
export function visibleTasks(tasks: Task[], options: ViewOptions, status: (t: Task) => Status): Task[] {
  const q = options.query.trim().toLocaleLowerCase();
  return tasks.filter(t => (!q || `${t.description} ${t.type} ${t.priority} ${decodeURI(t.uri)}`.toLocaleLowerCase().includes(q)) &&
    (!options.types.length || options.types.includes(t.type)) && (!options.priorities.length || options.priorities.includes(t.priority)) &&
    (!options.statuses.length || options.statuses.includes(status(t)))).sort((a, b) => {
    let primary = 0;
    if (options.sort === 'priority') { primary = PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority); }
    if (options.sort === 'type') { primary = TYPES.indexOf(a.type) - TYPES.indexOf(b.type); }
    if (options.sort === 'description') { primary = a.description.localeCompare(b.description); }
    return primary || a.uri.localeCompare(b.uri) || a.line - b.line || a.column - b.column;
  });
}
export function summarize(tasks: Task[], status: (t: Task) => Status) {
  const types = Object.fromEntries(TYPES.map(t => [t, 0])) as Record<TaskType, number>;
  const priorities = Object.fromEntries(PRIORITIES.map(p => [p, 0])) as Record<Priority, number>;
  const statuses = Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<Status, number>;
  for (const t of tasks) { types[t.type]++; priorities[t.priority]++; statuses[status(t)]++; }
  return { total: tasks.length, files: new Set(tasks.map(t => t.uri)).size, types, priorities, statuses };
}
/** Remove only this task; preserve neighbouring code, prose, comments and other markers. */
export function deletionRange(text: string, task: Task): { start: number; end: number } {
  const before = text.slice(task.contentStart, task.start);
  const after = text.slice(task.end, task.contentEnd);
  // A multiline block may have documentation-style stars around the task.
  if ((before + after).replace(/[\s*]/g, '') !== '') { return { start: task.start, end: task.end }; }
  const lineStart = text.lastIndexOf('\n', task.commentStart - 1) + 1;
  const nl = text.indexOf('\n', task.commentEnd);
  const lineEnd = nl < 0 ? text.length : nl;
  if (!text.slice(lineStart, task.commentStart).trim() && !text.slice(task.commentEnd, lineEnd).trim()) {
    return { start: lineStart, end: nl < 0 ? text.length : nl + 1 };
  }
  return { start: task.commentStart, end: task.commentEnd };
}
