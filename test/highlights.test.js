const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { parseTasks, PRIORITIES } = require('../dist/core');

// Exercise the actual decoration controller against the boundary of the VS Code API.
const options = new Map();
const context = new Map();
let visibleListener;
let disposed = 0;
const vscode = {
  ThemeColor: class { constructor(id) { this.id = id; } },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  DecorationRangeBehavior: { ClosedClosed: 1 },
  commands: { executeCommand: async (_, key, value) => context.set(key, value) },
  workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
  window: {
    visibleTextEditors: [],
    createTextEditorDecorationType: config => {
      const type = { dispose: () => disposed++ }; options.set(type, config); return type;
    },
    onDidChangeVisibleTextEditors: listener => { visibleListener = listener; return { dispose() {} }; }
  }
};
const load = Module._load;
let TaskHighlights;
try {
  Module._load = function (id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); };
  ({ TaskHighlights } = require('../dist/highlights'));
} finally { Module._load = load; }

function editor(text, path = 'main.py') {
  const painted = new Map();
  return {
    document: { uri: path, getText: () => text, positionAt: offset => offset, languageId: 'python' },
    painted,
    setDecorations(type, ranges) { painted.set(type, ranges); }
  };
}
const index = {
  eligible: uri => uri !== 'excluded.py',
  parse: doc => parseTasks(doc.getText(), doc.uri, doc.languageId)
};
function state(initial = true) {
  const data = new Map([['highlightEnabled', initial]]);
  return { get: (key, fallback) => data.get(key) ?? fallback, update: async (key, value) => { data.set(key, value); } };
}
function paintedMarkers(e) {
  return [...e.painted].flatMap(([type, ranges]) => ranges.map(r => ({
    text: e.document.getText().slice(r.start, r.end), color: options.get(type).backgroundColor.id
  })));
}

test('five priorities paint exactly the markers; strings and descriptions stay untouched', () => {
  const e = editor('# TODO[CRITICAL]: red\n# BUG[HIGH]: orange\n# FIXME[MEDIUM]: yellow\n# TODO[LOW]: blue\n# BUG: grey\ntext = "# TODO[HIGH]: ignore"');
  vscode.window.visibleTextEditors = [e];
  const highlighter = new TaskHighlights(index, state());
  const painted = paintedMarkers(e);
  assert.equal(painted.length, 5);
  assert.deepEqual(painted.map(p => p.text), ['TODO[CRITICAL]', 'BUG[HIGH]', 'FIXME[MEDIUM]', 'TODO[LOW]', 'BUG']);
  assert.equal(new Set(painted.map(p => p.color)).size, 5);
  for (const type of e.painted.keys()) {
    assert.equal(options.get(type).rangeBehavior, vscode.DecorationRangeBehavior.ClosedClosed);
  }
  highlighter.dispose();
});

test('disable clears every visible editor; enable restores and persists the choice', async () => {
  const first = editor('# TODO[HIGH]: first');
  const second = editor('# BUG[LOW]: second', 'second.py');
  const excluded = editor('# FIXME: excluded', 'excluded.py');
  vscode.window.visibleTextEditors = [first, second, excluded];
  const storage = state();
  const highlighter = new TaskHighlights(index, storage);
  assert.equal(paintedMarkers(first).length, 1); assert.equal(paintedMarkers(second).length, 1);
  assert.equal(paintedMarkers(excluded).length, 0);
  await highlighter.setEnabled(false);
  for (const e of [first, second, excluded]) { assert.equal(paintedMarkers(e).length, 0); }
  assert.equal(storage.get('highlightEnabled'), false);
  assert.equal(context.get('todoManager.highlightEnabled'), false);
  await highlighter.setEnabled(true);
  assert.equal(paintedMarkers(first).length, 1); assert.equal(paintedMarkers(second).length, 1);
  assert.equal(storage.get('highlightEnabled'), true);
  highlighter.dispose();
});

test('new editor respects disabled state; changed buffers refresh ranges and priorities', async () => {
  const storage = state(false);
  vscode.window.visibleTextEditors = [];
  const highlighter = new TaskHighlights(index, storage);
  const e = editor('# TODO[LOW]: before');
  vscode.window.visibleTextEditors = [e]; visibleListener();
  assert.equal(paintedMarkers(e).length, 0);
  await highlighter.setEnabled(true);
  assert.match(paintedMarkers(e)[0].color, /lowBackground$/);
  e.document.getText = () => '\n\n# TODO[CRITICAL]: after';
  highlighter.refresh();
  assert.deepEqual(paintedMarkers(e), [{ text: 'TODO[CRITICAL]', color: 'todoManager.highlight.criticalBackground' }]);
  highlighter.dispose();
  assert.equal(disposed, PRIORITIES.length * 3);
});
