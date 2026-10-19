import * as vscode from 'vscode';
import { DEFAULT_OPTIONS, PRIORITIES, STATUS_LABELS, Status, Task, TYPES, ViewOptions, visibleTasks } from './core';
import { TaskIndex } from './indexer';
export interface Group { key: string; label: string; tasks: Task[] }
export type Node = Task | Group;
export function isTask(node: unknown): node is Task { return !!node && typeof node === 'object' && 'uri' in node && 'start' in node; }
const icons = { TODO: 'checklist', FIXME: 'tools', BUG: 'bug' };
const colors = { CRITICAL: 'errorForeground', HIGH: 'editorWarning.foreground', MEDIUM: 'charts.yellow', LOW: 'charts.blue', NONE: 'descriptionForeground' };
export class TaskTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changes.event;
  options: ViewOptions;
  private readonly subscription: vscode.Disposable;
  constructor(readonly index: TaskIndex, private readonly state: vscode.Memento, readonly status: (task: Task) => Status) {
    this.options = { ...DEFAULT_OPTIONS, ...state.get<Partial<ViewOptions>>('viewOptions', {}) };
    this.subscription = index.onDidChange(() => this.refresh());
  }
  get visible(): Task[] { return visibleTasks(this.index.tasks, this.options, this.status); }
  async update(options: Partial<ViewOptions>): Promise<void> {
    this.options = { ...this.options, ...options };
    await this.state.update('viewOptions', this.options); this.refresh();
  }
  refresh(): void { this.changes.fire(undefined); }
  getChildren(node?: Node): Node[] {
    if (node) { return isTask(node) ? [] : node.tasks; }
    const tasks = this.visible;
    if (this.options.group === 'none') { return tasks; }
    const groups = new Map<string, Group>();
    for (const task of tasks) {
      let key: string, label: string;
      switch (this.options.group) {
        case 'type': key = task.type; label = task.type; break;
        case 'priority': key = task.priority; label = key === 'NONE' ? 'Без приоритета' : key; break;
        case 'status': key = this.status(task); label = STATUS_LABELS[this.status(task)]; break;
        default: key = task.uri; label = vscode.workspace.asRelativePath(vscode.Uri.parse(key));
      }
      if (!groups.has(key)) { groups.set(key, { key, label, tasks: [] }); }
      groups.get(key)!.tasks.push(task);
    }
    return [...groups.values()].sort((a, b) => this.options.group === 'priority'
      ? PRIORITIES.indexOf(a.key as typeof PRIORITIES[number]) - PRIORITIES.indexOf(b.key as typeof PRIORITIES[number])
      : this.options.group === 'type' ? TYPES.indexOf(a.key as typeof TYPES[number]) - TYPES.indexOf(b.key as typeof TYPES[number]) : a.label.localeCompare(b.label));
  }
  getTreeItem(node: Node): vscode.TreeItem {
    if (!isTask(node)) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${this.options.group}:${node.key}`; item.description = String(node.tasks.length);
      item.iconPath = new vscode.ThemeIcon(this.options.group === 'file' ? 'file-code' : 'list-tree');
      item.contextValue = 'todoGroup'; return item;
    }
    const status = this.status(node);
    const item = new vscode.TreeItem(`${node.type}${node.priority === 'NONE' ? '' : `[${node.priority}]`}: ${node.description || '(без описания)'}`);
    // URI and source offset disambiguate manually copied identifiers in the view.
    item.id = `task:${node.uri}:${node.start}`;
    item.description = `${STATUS_LABELS[status]} · ${this.options.group === 'file' ? '' : `${vscode.workspace.asRelativePath(vscode.Uri.parse(node.uri))}:`}${node.line + 1}`;
    item.contextValue = 'todoTask';
    item.iconPath = new vscode.ThemeIcon(status === 'done' ? 'pass-filled' : status === 'inProgress' ? 'play-circle' : status === 'deferred' ? 'history' : icons[node.type], new vscode.ThemeColor(colors[node.priority]));
    item.tooltip = `${node.type} · ${node.priority === 'NONE' ? 'Без приоритета' : node.priority}\n${node.description}\n${STATUS_LABELS[status]}\n${vscode.workspace.asRelativePath(vscode.Uri.parse(node.uri))}:${node.line + 1}:${node.column + 1}`;
    item.command = { command: 'todoManager.open', title: 'Открыть задачу', arguments: [node] };
    return item;
  }
  dispose(): void { this.subscription.dispose(); this.changes.dispose(); }
}
