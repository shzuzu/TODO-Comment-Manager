import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { languageForPath, parseTasks, SYNTAX, Syntax, Task } from './core';

export class TaskIndex implements vscode.Disposable {
  private readonly files = new Map<string, Task[]>();
  private readonly versions = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshPromise?: Promise<void>;
  private refreshAgain = false;
  private disposed = false;
  private readonly failures = new Set<string>();
  ready = false;
  get tasks(): Task[] { return [...this.files.values()].flat(); }
  get errors(): number { return this.failures.size; }
  constructor(private readonly output: vscode.OutputChannel) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(watcher,
      watcher.onDidCreate(uri => this.schedule(uri)), watcher.onDidChange(uri => this.schedule(uri)),
      watcher.onDidDelete(uri => this.remove(uri)),
      vscode.workspace.onDidChangeTextDocument(e => { if (e.contentChanges.length) { this.schedule(e.document.uri); } }),
      vscode.workspace.onDidOpenTextDocument(doc => this.schedule(doc.uri)),
      vscode.workspace.onDidSaveTextDocument(doc => this.schedule(doc.uri)),
      vscode.workspace.onDidCloseTextDocument(doc => this.schedule(doc.uri)),
      vscode.workspace.onDidRenameFiles(() => void this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('todoManager')) { void this.refresh(); } })
    );
  }
  private config(uri?: vscode.Uri) { return vscode.workspace.getConfiguration('todoManager', uri); }
  eligible(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) { return false; }
    const relative = uri.path.slice(folder.uri.path.length + 1);
    const config = this.config(uri);
    return minimatch(relative, config.get<string>('include', '**/*'), { dot: true }) &&
      !minimatch(relative, config.get<string>('exclude', ''), { dot: true });
  }
  syntax(document: vscode.TextDocument): Syntax | undefined {
    return this.config(document.uri).get<Record<string, Syntax>>('commentSyntax', {})[document.languageId];
  }
  parse(document: vscode.TextDocument): Task[] {
    return parseTasks(document.getText(), document.uri.toString(), document.languageId, this.syntax(document));
  }
  private remove(uri: vscode.Uri): void {
    // Folder deletion events may arrive without one event per descendant.
    for (const key of new Set([...this.files.keys(), ...this.versions.keys()])) {
      if (key === uri.toString() || key.startsWith(uri.toString().replace(/\/$/, '') + '/')) {
        this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
        this.files.delete(key); this.failures.delete(key);
        const timer = this.timers.get(key); if (timer) { clearTimeout(timer); this.timers.delete(key); }
      }
    }
    this.changes.fire();
  }
  private schedule(uri: vscode.Uri): void {
    if (this.disposed) { return; }
    const key = uri.toString();
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    const old = this.timers.get(key); if (old) { clearTimeout(old); }
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key); void this.scan(uri).then(() => this.changes.fire());
    }, this.config(uri).get<number>('debounceMs', 300)));
  }
  async scan(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const revision = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, revision);
    const valid = () => !this.disposed && this.versions.get(key) === revision;
    if (!this.eligible(uri)) { this.files.delete(key); this.failures.delete(key); return; }
    try {
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === key && !d.isClosed);
      const language = open?.languageId ?? languageForPath(uri.path);
      const custom = this.config(uri).get<Record<string, Syntax>>('commentSyntax', {})[language];
      if (!custom && !SYNTAX[language]) { if (valid()) { this.files.delete(key); this.failures.delete(key); } return; }
      const max = this.config(uri).get<number>('maxFileSizeKB', 1024) * 1024;
      let text: string;
      if (open) { text = open.getText(); }
      else {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > max) { if (valid()) { this.files.delete(key); } return; }
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      }
      if (valid()) {
        this.files.set(key, Buffer.byteLength(text, 'utf8') > max ? [] : parseTasks(text, key, language, custom));
        this.failures.delete(key);
      }
    } catch (error) {
      if (valid()) {
        this.files.delete(key);
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { this.failures.delete(key); }
        else { this.failures.add(key); this.output.appendLine(`Не удалось прочитать ${uri.toString()}: ${String(error)}`); }
      }
    }
  }
  refresh(): Promise<void> {
    if (this.refreshPromise) { this.refreshAgain = true; return this.refreshPromise; }
    this.refreshPromise = this.refreshAll().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }
  private async refreshAll(): Promise<void> {
    do {
      this.refreshAgain = false;
      try {
        const uris: vscode.Uri[] = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          const config = this.config(folder.uri);
          uris.push(...await vscode.workspace.findFiles(new vscode.RelativePattern(folder, config.get('include', '**/*')), config.get('exclude', '')));
        }
        const keys = new Set(uris.map(uri => uri.toString()));
        for (const key of this.files.keys()) { if (!keys.has(key)) { this.remove(vscode.Uri.parse(key)); } }
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(8, uris.length) }, async () => {
          while (next < uris.length && !this.disposed) { await this.scan(uris[next++]); }
        }));
      } catch (error) {
        this.output.appendLine(`Ошибка сканирования: ${String(error)}`);
        void vscode.window.showErrorMessage('TODO Manager: ошибка сканирования. Подробности в Output → TODO Manager.');
      }
      this.ready = true; this.changes.fire();
    } while (this.refreshAgain && !this.disposed);
  }
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) { clearTimeout(timer); }
    this.disposables.forEach(d => d.dispose()); this.changes.dispose();
  }
}
