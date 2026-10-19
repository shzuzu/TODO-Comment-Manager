import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { DEFAULT_OPTIONS, PRIORITIES, STATUSES, STATUS_LABELS, SYNTAX, Status, Task, TaskType, Priority, TYPES, ViewOptions, deletionRange, parseTasks, summarize, taskText, validDescription, wrapComment } from './core';
import { TaskIndex } from './indexer';
import { isTask, TaskTree } from './tree';
import { statisticsHtml } from './statistics';
import { TaskHighlights } from './highlights';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('TODO Manager');
  const index = new TaskIndex(output);
  const highlights = new TaskHighlights(index, context.workspaceState);
  let statuses = context.workspaceState.get<Record<string, Status>>('taskStatuses', {});
  let idCounts = new Map<string, number>();
  const countIds = () => {
    idCounts = new Map();
    for (const task of index.tasks) { if (task.id) { idCounts.set(task.id, (idCounts.get(task.id) ?? 0) + 1); } }
  };
  context.subscriptions.push(index.onDidChange(countIds));
  const statusOf = (task: Task): Status => task.id && idCounts.get(task.id) === 1 ? statuses[task.id] ?? 'open' : 'open';
  const tree = new TaskTree(index, context.workspaceState, statusOf);
  const view = vscode.window.createTreeView('todoManager.tasks', { treeDataProvider: tree, showCollapseAll: true });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'todoManager.statistics';
  let panel: vscode.WebviewPanel | undefined;
  const redraw = () => {
    highlights.refresh();
    countIds();
    const stats = summarize(index.tasks, statusOf);
    statusBar.text = `$(checklist) TODO ${stats.total} · ✓ ${stats.statuses.done}`;
    statusBar.tooltip = 'TODO Manager: открыть статистику проекта';
    if (vscode.workspace.workspaceFolders?.length) { statusBar.show(); } else { statusBar.hide(); }
    const o = tree.options;
    view.description = `${tree.visible.length}/${stats.total}${o.query ? ` · «${o.query}»` : ''}${o.types.length || o.priorities.length || o.statuses.length ? ' · фильтры' : ''}`;
    view.message = !vscode.workspace.workspaceFolders?.length ? 'Откройте папку проекта, чтобы найти TODO, FIXME и BUG.'
      : !index.ready ? 'Сканирование проекта…'
      : index.errors ? `Не удалось прочитать файлов: ${index.errors}. Подробности: Output → TODO Manager.`
      : !tree.visible.length ? stats.total ? 'Нет задач с такими условиями. Используйте «Сбросить поиск и фильтры».' : 'Задач пока нет. Выделите строку и нажмите «+», чтобы создать комментарий.' : undefined;
    if (panel) { panel.webview.html = statisticsHtml(stats, panel.webview.cspSource); }
  };
  const command = (name: string, action: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`todoManager.${name}`, async (...args: any[]) => {
    try { return await action(...args); }
    catch (error) { output.appendLine(String(error)); void vscode.window.showErrorMessage(`TODO Manager: ${error instanceof Error ? error.message : String(error)}`); }
  }));
  const updateOptions = async (options: Partial<ViewOptions>) => { await tree.update(options); redraw(); };
  const selectTask = async (node?: Task): Promise<Task | undefined> => {
    if (isTask(node)) { return node; }
    const choices = tree.visible.map(task => ({ label: `${task.type}: ${task.description}`, description: `${vscode.workspace.asRelativePath(vscode.Uri.parse(task.uri))}:${task.line + 1}`, task }));
    if (!choices.length) { void vscode.window.showInformationMessage('Нет задач для выбранного действия.'); return; }
    return (await vscode.window.showQuickPick(choices, { placeHolder: 'Выберите задачу', matchOnDescription: true }))?.task;
  };
  // Re-read before every action: a TreeItem may refer to a stale editor buffer.
  const resolve = async (original: Task) => {
    let uri = vscode.Uri.parse(original.uri);
    if (original.id) {
      const located = index.tasks.filter(t => t.id === original.id);
      if (located.length === 1) { uri = vscode.Uri.parse(located[0].uri); }
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const candidates = index.parse(document).filter(t => original.id ? t.id === original.id : !t.id && t.type === original.type && t.priority === original.priority && t.description === original.description);
    const task = candidates.length === 1 ? candidates[0] : candidates.find(t => t.start === original.start && t.sourceHash === original.sourceHash);
    if (!task) { throw new Error('Комментарий изменён или его нельзя однозначно определить. Выберите задачу в обновлённой панели.'); }
    return { task, document };
  };
  const uniqueId = (task: Task) => task.id && index.tasks.filter(t => t.id === task.id).length <= 1 ? task.id : randomUUID();
  const replace = async (document: vscode.TextDocument, start: number, end: number, text: string) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
    if (!await vscode.workspace.applyEdit(edit)) { throw new Error('Редактор не смог применить изменение. Проверьте доступ к файлу.'); }
    await index.scan(document.uri); tree.refresh(); redraw();
  };
  const details = async (language: string, current?: Task, custom?: import('./core').Syntax) => {
    const syntax = custom ?? SYNTAX[language];
    if (!syntax || (!syntax.line?.length && !syntax.block?.length)) { throw new Error(`Язык «${language}» не поддержан. Настройте todoManager.commentSyntax.`); }
    const type = await vscode.window.showQuickPick(TYPES.map(t => ({ label: t, picked: t === current?.type })), { title: '1/3 · Тип задачи' });
    if (!type) { return; }
    const priority = await vscode.window.showQuickPick(PRIORITIES.map(p => ({ label: p, description: p === 'NONE' ? 'Без приоритета' : undefined, picked: p === current?.priority })), { title: '2/3 · Приоритет' });
    if (!priority) { return; }
    const description = await vscode.window.showInputBox({ title: '3/3 · Описание задачи', value: current?.description ?? '', prompt: 'Одна строка; идентификатор создаётся автоматически', validateInput: value => validDescription(value, syntax) });
    if (description === undefined) { return; }
    return { type: type.label as TaskType, priority: priority.label as Priority, description: description.trim(), syntax };
  };
  command('enableHighlight', () => highlights.setEnabled(true));
  command('disableHighlight', () => highlights.setEnabled(false));
  command('refresh', () => vscode.window.withProgress({ location: { viewId: 'todoManager.tasks' }, title: 'Поиск TODO' }, () => index.refresh()));
  command('open', async (node?: Task) => {
    const original = await selectTask(node); if (!original) { return; }
    const { task, document } = await resolve(original);
    const editor = await vscode.window.showTextDocument(document);
    const range = new vscode.Range(document.positionAt(task.start), document.positionAt(task.end));
    editor.selection = new vscode.Selection(range.start, range.end); editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });
  command('add', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { throw new Error('Откройте файл и выделите строку кода.'); }
    if (!index.eligible(editor.document.uri)) { throw new Error('Файл вне проекта или исключён настройками сканирования.'); }
    const document = editor.document, version = document.version;
    const lineNumber = editor.selection.start.line;
    const values = await details(document.languageId, undefined, index.syntax(document)); if (!values) { return; }
    if (document.isClosed || document.version !== version) { throw new Error('Файл изменился во время ввода. Повторите создание задачи.'); }
    const indent = document.lineAt(lineNumber).text.match(/^\s*/)?.[0] ?? '';
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const id = randomUUID();
    const text = indent + wrapComment(taskText(values.type, values.priority, values.description, id), values.syntax) + eol;
    const offset = document.offsetAt(new vscode.Position(lineNumber, 0));
    const current = document.getText();
    const proposed = current.slice(0, offset) + text + current.slice(offset);
    if (!parseTasks(proposed, document.uri.toString(), document.languageId, values.syntax).some(t => t.id === id)) {
      throw new Error('В этом месте комментарий не распознаётся: возможно, выделение находится внутри многострочной строки. Выберите строку кода.');
    }
    await replace(document, offset, offset, text);
  });
  command('edit', async (node?: Task) => {
    const original = await selectTask(node); if (!original) { return; }
    const initial = await resolve(original);
    const values = await details(initial.document.languageId, initial.task, index.syntax(initial.document)); if (!values) { return; }
    const { task, document } = await resolve(initial.task);
    await replace(document, task.start, task.end, taskText(values.type, values.priority, values.description, uniqueId(task)));
  });
  command('delete', async (node?: Task) => {
    const original = await selectTask(node); if (!original) { return; }
    const initial = await resolve(original);
    const answer = await vscode.window.showWarningMessage(`Удалить комментарий «${initial.task.description || initial.task.type}»?`, { modal: true, detail: 'Изменение можно отменить стандартной командой Undo в редакторе.' }, 'Удалить');
    if (answer !== 'Удалить') { return; }
    const { task, document } = await resolve(initial.task);
    const range = deletionRange(document.getText(), task);
    await replace(document, range.start, range.end, '');
  });
  command('status', async (node?: Task) => {
    const original = await selectTask(node); if (!original) { return; }
    const choice = await vscode.window.showQuickPick(STATUSES.map(value => ({ label: STATUS_LABELS[value], value })), { title: 'Статус задачи', placeHolder: 'При первом назначении статуса в комментарий добавляется ID' });
    if (!choice) { return; }
    const { task, document } = await resolve(original);
    const id = uniqueId(task);
    if (task.id !== id) { await replace(document, task.start, task.end, taskText(task.type, task.priority, task.description, id)); }
    const next = { ...statuses, [id]: choice.value };
    await context.workspaceState.update('taskStatuses', next); statuses = next;
    tree.refresh(); redraw();
  });
  command('search', async () => {
    const query = await vscode.window.showInputBox({ title: 'Поиск задач', prompt: 'Описание, путь, тип или приоритет. Пустая строка сбрасывает поиск.', value: tree.options.query });
    if (query !== undefined) { await updateOptions({ query }); }
  });
  command('group', async () => {
    const choices: { label: string; value: ViewOptions['group'] }[] = [{ label: 'По файлам', value: 'file' }, { label: 'По типам', value: 'type' }, { label: 'По приоритетам', value: 'priority' }, { label: 'По статусам', value: 'status' }, { label: 'Без группировки', value: 'none' }];
    const choice = await vscode.window.showQuickPick(choices, { title: 'Группировка задач' }); if (choice) { await updateOptions({ group: choice.value }); }
  });
  command('sort', async () => {
    const choices: { label: string; value: ViewOptions['sort'] }[] = [{ label: 'По приоритету: критические первыми', value: 'priority' }, { label: 'По расположению в файле', value: 'location' }, { label: 'По типу', value: 'type' }, { label: 'По описанию', value: 'description' }];
    const choice = await vscode.window.showQuickPick(choices, { title: 'Сортировка задач внутри группы' }); if (choice) { await updateOptions({ sort: choice.value }); }
  });
  command('filter', async () => {
    type Choice = vscode.QuickPickItem & { kindId: 'types' | 'priorities' | 'statuses'; value: string };
    const choices: Choice[] = [
      ...TYPES.map(value => ({ label: value, description: 'Тип', kindId: 'types' as const, value, picked: tree.options.types.includes(value) })),
      ...PRIORITIES.map(value => ({ label: value === 'NONE' ? 'Без приоритета' : value, description: 'Приоритет', kindId: 'priorities' as const, value, picked: tree.options.priorities.includes(value) })),
      ...STATUSES.map(value => ({ label: STATUS_LABELS[value], description: 'Статус', kindId: 'statuses' as const, value, picked: tree.options.statuses.includes(value) }))
    ];
    const chosen = await vscode.window.showQuickPick(choices, { canPickMany: true, title: 'Фильтры задач', placeHolder: 'Внутри категории — ИЛИ, между категориями — И. Без выбора — все задачи.' });
    if (chosen) { await updateOptions({ types: chosen.filter(c => c.kindId === 'types').map(c => c.value as TaskType), priorities: chosen.filter(c => c.kindId === 'priorities').map(c => c.value as Priority), statuses: chosen.filter(c => c.kindId === 'statuses').map(c => c.value as Status) }); }
  });
  command('reset', () => updateOptions({ ...DEFAULT_OPTIONS, group: tree.options.group, sort: tree.options.sort }));
  command('statistics', () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('todoManager.statistics', 'TODO · Статистика проекта', vscode.ViewColumn.One, { enableScripts: false });
    panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions); redraw();
  });
  context.subscriptions.push(output, index, highlights, tree, view, statusBar, index.onDidChange(redraw), { dispose: () => panel?.dispose() });
  redraw(); void index.refresh();
  return { index, tree, highlights, statusOf, ready: () => index.refresh(), getStatus: (id: string) => statuses[id] };
}
