const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-manager-test-'));
  const workspace = path.join(root, 'workspace');
  const harness = path.join(root, 'harness');
  const profile = path.join(root, 'profile');
  await fs.mkdir(workspace); await fs.mkdir(harness); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({ 'chat.disableAIFeatures': true, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }));
  await fs.writeFile(path.join(workspace, 'main.ts'), 'const text = "// TODO: fake";\n// TODO[HIGH]: First task\n// BUG[CRITICAL]: Broken\n');
  await fs.writeFile(path.join(workspace, 'script.py'), 'def run():\n    pass\n');
  await fs.writeFile(path.join(harness, 'package.json'), JSON.stringify({ name: 'todo-manager-test-harness', version: '0.0.1', publisher: 'local-test', engines: { vscode: '^1.96.0' }, activationEvents: ['onStartupFinished'], main: './extension.js' }));
  await fs.writeFile(path.join(harness, 'extension.js'), `
const vscode = require('vscode');
const fs = require('node:fs/promises');
exports.activate = async () => {
  let result;
  try { await require(${JSON.stringify(path.join(__dirname, 'integration.cjs'))}).run(); result = { ok: true }; }
  catch (error) { result = { ok: false, error: error.stack || String(error) }; }
  await fs.writeFile(process.env.TODO_TEST_RESULT, JSON.stringify(result));
  await vscode.commands.executeCommand('workbench.action.quit');
};
`);
  let developmentPath = path.resolve(__dirname, '..');
  if (process.argv[2] === '--vsix') {
    const extracted = path.join(root, 'packaged');
    execFileSync('unzip', ['-q', path.resolve(process.argv[3]), '-d', extracted]);
    developmentPath = path.join(extracted, 'extension');
    // VS Code creates a separate API object for each extension. Keep the test
    // module inside the target extension so its UI mocks patch that same object.
    const packagedTests = path.join(developmentPath, 'integration-test.cjs');
    await fs.copyFile(path.join(__dirname, 'integration.cjs'), packagedTests);
    const harnessFile = path.join(harness, 'extension.js');
    const source = await fs.readFile(harnessFile, 'utf8');
    await fs.writeFile(harnessFile, source.replace(JSON.stringify(path.join(__dirname, 'integration.cjs')), JSON.stringify(packagedTests)));
  }
  const executable = process.env.VSCODE_EXECUTABLE_PATH || (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : await downloadAndUnzipVSCode());
  try {
    for (const phase of ['first', 'restart']) {
      const resultFile = path.join(root, `${phase}.json`);
      // The standard --extensionTestsPath mode forces in-memory mementos in VS Code.
      // A tiny startup harness in normal development mode verifies actual disk persistence.
      const args = [workspace, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(root, 'extensions')}`, `--extensionDevelopmentPath=${developmentPath}`, `--extensionDevelopmentPath=${harness}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-gpu', '--no-sandbox'];
      await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { env: { ...process.env, TODO_TEST_PHASE: phase, TODO_TEST_META: path.join(root, 'meta.json'), TODO_TEST_RESULT: resultFile } });
        let logs = '';
        child.stdout.on('data', data => { logs = (logs + data.toString()).slice(-18000); });
        child.stderr.on('data', data => { logs = (logs + data.toString()).slice(-18000); });
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`VS Code ${phase} timed out:\n${logs}`)); }, 60000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`VS Code exited ${code ?? signal}:\n${logs}`)); });
      });
      const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
      if (!result.ok) { throw new Error(result.error); }
      console.log(`PASS: VS Code ${phase} session`);
    }
    console.log('Integration: CRUD, watchers, navigation, filtering, report, persistent statuses, rename and line movement passed.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
