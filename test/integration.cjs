const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vscode = require('vscode');
async function until(predicate, message) {
  const limit = Date.now() + 15000;
  while (Date.now() < limit) {
    if (predicate()) { return; }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${message}`);
}
async function withPrompts(quickPicks, inputs, action) {
  const oldPick = vscode.window.showQuickPick, oldInput = vscode.window.showInputBox;
  vscode.window.showQuickPick = async items => {
    const label = quickPicks.shift();
    const item = items.find(i => i.label === label);
    assert.ok(item, `QuickPick option ${label} exists`); return item;
  };
  vscode.window.showInputBox = async options => {
    const value = inputs.shift();
    assert.equal(options.validateInput?.(value), undefined); return value;
  };
  try { return await action(); }
  finally { vscode.window.showQuickPick = oldPick; vscode.window.showInputBox = oldInput; }
}
exports.run = async () => {
  const extension = vscode.extensions.getExtension('sherm-dev.todo-comment-manager');
  assert.ok(extension, 'Extension is installed in development host');
  const api = await extension.activate(); await api.ready();
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const uri = vscode.Uri.joinPath(folder, 'main.ts');
  if (process.env.TODO_TEST_PHASE === 'restart') {
    const { id } = JSON.parse(await fs.readFile(process.env.TODO_TEST_META, 'utf8'));
    const task = api.index.tasks.find(t => t.id === id);
    assert.ok(task, 'Persistent ID loaded from source');
    assert.equal(api.statusOf(task), 'inProgress', 'Workspace status survives real VS Code restart');
    assert.equal(api.tree.options.group, 'priority', 'View preferences survive restart');
    assert.equal(api.highlights.enabled, false, 'Highlight toggle survives a real restart');
    await vscode.commands.executeCommand('todoManager.enableHighlight');
    assert.equal(api.highlights.enabled, true, 'Highlight can be enabled after restart');
    const renamed = vscode.Uri.joinPath(folder, 'renamed.ts');
    const rename = new vscode.WorkspaceEdit(); rename.renameFile(uri, renamed);
    assert.ok(await vscode.workspace.applyEdit(rename));
    await until(() => api.index.tasks.some(t => t.id === id && t.uri === renamed.toString()), 'rename update');
    const moved = api.index.tasks.find(t => t.id === id);
    assert.equal(api.statusOf(moved), 'inProgress', 'Status follows file rename');
    const doc = await vscode.workspace.openTextDocument(renamed);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(renamed, new vscode.Position(0, 0), '\n\n// Added heading\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await until(() => api.index.tasks.find(t => t.id === id)?.line === moved.line + 3, 'line movement');
    assert.equal(api.statusOf(api.index.tasks.find(t => t.id === id)), 'inProgress');
    await doc.save();
    console.log('PASS: restart persistence, view preferences, file rename and line movement');
    return;
  }
  assert.equal(api.index.tasks.length, 2, 'Initial scan excludes TODO strings');
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  assert.equal(api.highlights.enabled, true, 'Highlight is enabled by default');
  await vscode.commands.executeCommand('todoManager.disableHighlight');
  assert.equal(api.highlights.enabled, false);
  await vscode.commands.executeCommand('todoManager.enableHighlight');
  assert.equal(api.highlights.enabled, true);
  const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(0, 0), '// FIXME[LOW]: Live unsaved\n');
  assert.ok(await vscode.workspace.applyEdit(edit));
  await until(() => api.index.tasks.length === 3, 'unsaved change automatically indexed');
  assert.equal(doc.isDirty, true);
  const task = api.index.tasks.find(t => t.type === 'TODO');
  await vscode.commands.executeCommand('todoManager.open', task);
  assert.equal(vscode.window.activeTextEditor.selection.start.line, task.line, 'Navigation selects correct line');
  await withPrompts(['В работе'], [], () => vscode.commands.executeCommand('todoManager.status', task));
  const tracked = api.index.tasks.find(t => t.type === 'TODO');
  assert.ok(tracked.id); assert.equal(api.statusOf(tracked), 'inProgress');
  assert.match(doc.getText(), /\{#todo:/);
  await withPrompts(['TODO', 'HIGH'], ['Edited description'], () => vscode.commands.executeCommand('todoManager.edit', tracked));
  const edited = api.index.tasks.find(t => t.id === tracked.id);
  assert.equal(edited.description, 'Edited description'); assert.equal(api.statusOf(edited), 'inProgress');
  // A copied ID must not silently bind a different task to the original status.
  const duplicateEdit = new vscode.WorkspaceEdit();
  duplicateEdit.insert(uri, doc.positionAt(doc.getText().length), `// TODO: Copied {#todo:${edited.id}}\n`);
  assert.ok(await vscode.workspace.applyEdit(duplicateEdit));
  await until(() => api.index.tasks.some(t => t.description === 'Copied'), 'duplicate ID discovery');
  const copied = api.index.tasks.find(t => t.description === 'Copied');
  assert.equal(api.statusOf(copied), 'open');
  await withPrompts(['Отложено'], [], () => vscode.commands.executeCommand('todoManager.status', copied));
  const repaired = api.index.tasks.find(t => t.description === 'Copied');
  assert.notEqual(repaired.id, edited.id); assert.equal(api.statusOf(repaired), 'deferred');
  assert.equal(api.statusOf(api.index.tasks.find(t => t.id === edited.id)), 'inProgress');
  const previousWarning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async () => 'Удалить';
  try { await vscode.commands.executeCommand('todoManager.delete', repaired); }
  finally { vscode.window.showWarningMessage = previousWarning; }
  await doc.save();
  const python = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'script.py'));
  const pyEditor = await vscode.window.showTextDocument(python);
  pyEditor.selection = new vscode.Selection(1, 4, 1, 8);
  await withPrompts(['BUG', 'CRITICAL'], ['Python task'], () => vscode.commands.executeCommand('todoManager.add'));
  assert.match(python.getText(), /    # BUG\[CRITICAL\]: Python task \{#todo:/);
  assert.match(python.getText(), /    pass/); await python.save();
  const pyTask = api.index.tasks.find(t => t.description === 'Python task');
  const oldWarning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async () => 'Удалить';
  try { await vscode.commands.executeCommand('todoManager.delete', pyTask); }
  finally { vscode.window.showWarningMessage = oldWarning; }
  assert.equal(python.getText(), 'def run():\n    pass\n', 'Delete preserves selected source line');
  await python.save();
  const generated = vscode.Uri.joinPath(folder, 'external.ts');
  await vscode.workspace.fs.writeFile(generated, Buffer.from('// BUG: External file\n'));
  await until(() => api.index.tasks.some(t => t.uri === generated.toString()), 'file creation watcher');
  await vscode.workspace.fs.delete(generated);
  await until(() => !api.index.tasks.some(t => t.uri === generated.toString()), 'file deletion watcher');
  await api.tree.update({ group: 'priority', query: 'Edited' });
  assert.equal(api.tree.visible.length, 1);
  assert.equal(api.tree.getChildren()[0].key, 'HIGH');
  await api.tree.update({ query: '' });
  await vscode.commands.executeCommand('todoManager.statistics');
  assert.equal(api.index.tasks.length, 3);
  if (process.env.TODO_TEST_PREVIEW === '1') {
    const preview = vscode.Uri.joinPath(folder, 'highlight-preview.py');
    await vscode.workspace.fs.writeFile(preview, Buffer.from([
      '# BUG[CRITICAL]: Исправить потерю данных',
      '# FIXME[HIGH]: Обработать ошибку соединения',
      '# TODO[MEDIUM]: Добавить проверку входных данных',
      '# TODO[LOW]: Обновить документацию',
      '# FIXME: Упростить обработчик',
      '',
      'example = "# TODO[HIGH]: Строка не подсвечивается"',
      'print("Highlight demo")', ''
    ].join('\n')));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(preview));
    await vscode.commands.executeCommand('todoManager.tasks.focus');
    await new Promise(resolve => setTimeout(resolve, 30000));
    await vscode.workspace.fs.delete(preview);
  }
  await vscode.commands.executeCommand('todoManager.disableHighlight');
  assert.equal(api.highlights.enabled, false);
  await fs.writeFile(process.env.TODO_TEST_META, JSON.stringify({ id: edited.id }));
  // Give VS Code's persisted memento write queue time to flush before host exit.
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.ok(editor.document);
  console.log('PASS: initial scan, unsaved updates, navigation, status, editing, Python creation/deletion, disk watchers, grouping, search, statistics');
};
