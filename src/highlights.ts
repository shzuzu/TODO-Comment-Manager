import * as vscode from 'vscode';
import { PRIORITIES, Priority } from './core';
import { TaskIndex } from './indexer';

/** Paint only parsed comment markers, independently of the Tree View filters. */
export class TaskHighlights implements vscode.Disposable {
  private readonly decorations = new Map<Priority, vscode.TextEditorDecorationType>();
  private readonly subscriptions: vscode.Disposable[];
  private active: boolean;
  get enabled(): boolean { return this.active; }

  constructor(private readonly index: TaskIndex, private readonly state: vscode.Memento) {
    this.active = state.get<boolean>('highlightEnabled', true);
    for (const priority of PRIORITIES) {
      const colorId = `todoManager.highlight.${priority.toLowerCase()}`;
      this.decorations.set(priority, vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor(`${colorId}Background`),
        color: new vscode.ThemeColor(`${colorId}Foreground`),
        fontWeight: '600',
        borderRadius: '3px',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
      }));
    }
    this.subscriptions = [
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh())
    ];
    void vscode.commands.executeCommand('setContext', 'todoManager.highlightEnabled', this.active);
    this.refresh();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.state.update('highlightEnabled', enabled);
    this.active = enabled;
    await vscode.commands.executeCommand('setContext', 'todoManager.highlightEnabled', enabled);
    this.refresh();
  }

  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = new Map<Priority, vscode.Range[]>(PRIORITIES.map(priority => [priority, []]));
      const max = vscode.workspace.getConfiguration('todoManager', editor.document.uri).get<number>('maxFileSizeKB', 1024) * 1024;
      if (this.active && this.index.eligible(editor.document.uri) && Buffer.byteLength(editor.document.getText(), 'utf8') <= max) {
        // Parse the current buffer: workspace scans can finish while it is being edited.
        for (const task of this.index.parse(editor.document)) {
          ranges.get(task.priority)!.push(new vscode.Range(
            editor.document.positionAt(task.start), editor.document.positionAt(task.markerEnd)
          ));
        }
      }
      for (const [priority, decoration] of this.decorations) {
        editor.setDecorations(decoration, ranges.get(priority)!);
      }
    }
  }

  dispose(): void {
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.decorations.forEach(decoration => decoration.dispose());
  }
}
