const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTasks, taskText, wrapComment, deletionRange, validDescription, SYNTAX, DEFAULT_OPTIONS, visibleTasks, summarize, languageForPath } = require('../dist/core');
const parse = (text, lang = 'typescript') => parseTasks(text, 'file:///project/main.ts', lang);

test('types, priorities, zero-based locations and CRLF', () => {
  const tasks = parse('const x = 1;\r\n  // TODO[HIGH]: Build it\r\n/* FIXME[MEDIUM]: Fix it */\r\n// BUG[CRITICAL]: Crash');
  assert.deepEqual(tasks.map(t => [t.type, t.priority, t.line, t.column, t.description]), [
    ['TODO', 'HIGH', 1, 5, 'Build it'], ['FIXME', 'MEDIUM', 2, 3, 'Fix it'], ['BUG', 'CRITICAL', 3, 3, 'Crash']
  ]);
});
test('ignores strings, templates, ordinary identifiers and uncommented text', () => {
  assert.equal(parse('const a = "// TODO: fake";\nconst b = `/* BUG: fake */`;\nTODO: code\n// TODOS: no\n// DEBUG: no\n// TODO[UNKNOWN]: no').length, 0);
});
test('escaped quotes do not terminate strings', () => {
  assert.equal(parse('const a = "escaped \\" // TODO: fake"; // FIXME: real').length, 1);
});
test('python multiline strings are not comments', () => {
  assert.deepEqual(parse('"""\n# TODO: docstring\n"""\nx = "# BUG: fake"\n# FIXME: real', 'python').map(t => t.description), ['real']);
});
test('html prose apostrophes do not swallow comments', () => {
  assert.equal(parse("<p>Don't wait</p> <!-- TODO: ship -->", 'html')[0].description, 'ship');
});
test('CSS, SQL, Lua, shell and custom syntax', () => {
  assert.equal(parse('/* BUG: css */', 'css')[0].type, 'BUG');
  assert.equal(parse("select '-- TODO: string'; -- FIXME: query", 'sql').length, 1);
  assert.equal(parse('--[[\nTODO: lua\n]]', 'lua')[0].description, 'lua');
  assert.equal(parse('# TODO: shell', 'shellscript').length, 1);
  assert.equal(parseTasks('; TODO: custom', 'x', 'custom', { line: [';'] }).length, 1);
});
test('no priority, optional colon, empty description, many markers per comment', () => {
  const tasks = parse('// TODO plain FIXME: fix BUG');
  assert.deepEqual(tasks.map(t => t.description), ['plain', 'fix', '']);
  assert.equal(tasks[0].priority, 'NONE');
});
test('stable ID survives line movement and description/type/priority changes', () => {
  const id = 'abcd1234-5678';
  const a = parse('// TODO: old {#todo:' + id + '}')[0];
  const b = parse('\n\n// BUG[HIGH]: new {#todo:' + id + '}')[0];
  assert.equal(a.id, b.id); assert.equal(b.line, 2); assert.equal(b.description, 'new');
});
test('identical descriptions with different IDs remain distinct', () => {
  const tasks = parse('// TODO: same {#todo:aaaaaaaa}\n// TODO: same {#todo:bbbbbbbb}');
  assert.notEqual(tasks[0].id, tasks[1].id);
});
test('same task offset in different snapshots has different source hash', () => {
  assert.notEqual(parse('// TODO: same')[0].sourceHash, parse('// TODO: same\nconst changed = true')[0].sourceHash);
});
test('deleting standalone comments removes only their line', () => {
  const text = 'const a = 1;\r\n  // TODO: delete\r\nconst b = 2;';
  const range = deletionRange(text, parse(text)[0]);
  assert.equal(text.slice(0, range.start) + text.slice(range.end), 'const a = 1;\r\nconst b = 2;');
});
test('deleting inline task preserves source code', () => {
  const text = 'execute(); // BUG: fail'; const range = deletionRange(text, parse(text)[0]);
  assert.equal(text.slice(0, range.start) + text.slice(range.end), 'execute(); ');
});
test('deleting task preserves neighbouring marker and prose', () => {
  const text = '// note: TODO: a FIXME: b'; const tasks = parse(text); const range = deletionRange(text, tasks[0]);
  const result = text.slice(0, range.start) + text.slice(range.end);
  assert.match(result, /note:/); assert.equal(parse(result)[0].type, 'FIXME');
});
test('deleting multiline block preserves unrelated explanation', () => {
  const text = '/*\n * Explanation\n * TODO: fix\n */'; const range = deletionRange(text, parse(text)[0]);
  assert.match(text.slice(0, range.start) + text.slice(range.end), /Explanation/);
});
test('deleting task from sole block removes empty block', () => {
  const text = '/*\n * TODO: fix\n */\nrun();'; const range = deletionRange(text, parse(text)[0]);
  assert.equal(text.slice(0, range.start) + text.slice(range.end), 'run();');
});
test('formatting matches language and round-trips', () => {
  const content = taskText('BUG', 'CRITICAL', 'Fix error', 'aaaaaaaa');
  for (const lang of ['typescript', 'python', 'css', 'html', 'sql', 'lua']) {
    const text = wrapComment(content, SYNTAX[lang]); const task = parse(text, lang)[0];
    assert.equal(task.id, 'aaaaaaaa'); assert.equal(task.description, 'Fix error'); assert.equal(task.priority, 'CRITICAL');
  }
});
test('invalid descriptions cannot escape comments or forge IDs', () => {
  for (const text of ['', 'a\nb', 'oops */ code', 'x {#todo:aaaaaaaa}', 'also TODO: second']) {
    assert.ok(validDescription(text, SYNTAX.typescript));
  }
  assert.ok(validDescription('oops -->', SYNTAX.html));
  assert.equal(validDescription('Проверить обработку ошибок', SYNTAX.python), undefined);
});
test('filters combine categories with AND, category values with OR', () => {
  const tasks = parse('// TODO[HIGH]: Alpha\n// BUG[HIGH]: Alpha\n// FIXME[LOW]: Beta');
  const options = { ...DEFAULT_OPTIONS, query: 'alpha', types: ['TODO', 'BUG'], priorities: ['HIGH'], statuses: ['open'] };
  assert.equal(visibleTasks(tasks, options, () => 'open').length, 2);
  assert.equal(visibleTasks(tasks, options, () => 'done').length, 0);
});
test('search also matches file path, type and priority', () => {
  const tasks = parse('// TODO[HIGH]: Build');
  for (const query of ['main.ts', 'todo', 'high', 'BUILD']) { assert.equal(visibleTasks(tasks, { ...DEFAULT_OPTIONS, query }, () => 'open').length, 1); }
});
test('sort critical first and use locations for equal priorities', () => {
  const tasks = parse('// TODO: none\n// FIXME[LOW]: low\n// BUG[CRITICAL]: critical\n// TODO[HIGH]: high');
  assert.deepEqual(visibleTasks(tasks, DEFAULT_OPTIONS, () => 'open').map(t => t.priority), ['CRITICAL', 'HIGH', 'LOW', 'NONE']);
});
test('statistics include all types, priorities, completion and unique files', () => {
  const tasks = parse('// TODO[HIGH]: a\n// FIXME: b\n// BUG[CRITICAL]: c');
  const stats = summarize(tasks, task => task.type === 'TODO' ? 'done' : 'open');
  assert.equal(stats.total, 3); assert.equal(stats.files, 1); assert.equal(stats.statuses.done, 1); assert.equal(stats.priorities.CRITICAL, 1); assert.equal(stats.types.FIXME, 1);
  assert.equal(summarize([], () => 'open').total, 0);
});
test('unknown and binary files are skipped', () => {
  assert.equal(parse('// TODO: x', 'plaintext').length, 0);
  assert.equal(parse('// TODO: x\0').length, 0);
});
test('file name language detection', () => {
  assert.equal(languageForPath('/x/foo.tsx'), 'typescriptreact');
  assert.equal(languageForPath('/x/Dockerfile'), 'dockerfile');
  assert.equal(languageForPath('/x/Makefile'), 'makefile');
  assert.equal(languageForPath('/x/file.json'), '');
});
test('JS regex comment characters are skipped while division keeps actual comments', () => {
  const tasks = parse('const rx = /[//] TODO: fake/;\nconst n = a / b; // TODO: real');
  assert.deepEqual(tasks.map(t => t.description), ['real']);
});
test('HTML quoted attributes containing comment delimiters are not comments', () => {
  const tasks = parse('<div title="<!-- TODO: fake -->">Don\'t wait</div>\n<!-- BUG: real -->', 'html');
  assert.deepEqual(tasks.map(t => t.description), ['real']);
});
test('highlight marker ends at closing bracket, excluding colon, spaces, description and ID', () => {
  const text = '// TODO[HIGH]: Build {#todo:aaaaaaaa}\n/* BUG[CRITICAL]: Crash */\n// FIXME: Fix';
  const tasks = parse(text);
  assert.deepEqual(tasks.map(t => text.slice(t.start, t.markerEnd)), ['TODO[HIGH]', 'BUG[CRITICAL]', 'FIXME']);
});
