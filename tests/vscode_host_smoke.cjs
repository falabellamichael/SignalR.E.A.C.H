/* Run with VS Code --extensionTestsPath <this file>. No model requests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri;
  const reportPath = path.join(root.fsPath, 'host-smoke-result.json');
  const checks = [];
  try {
    const extension = vscode.extensions.getExtension('simplereach.simplereach');
    assert.ok(extension, 'REACH extension is discoverable');
    await extension.activate();
    checks.push('REACH activated in a real VS Code extension host');
    const { AgentBridge } = require(path.join(extension.extensionPath, 'agent-bridge.js'));
    const bridge = new AgentBridge(vscode);
    const file = vscode.Uri.joinPath(root, 'example.js');
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '// unsaved host smoke\n'));
    const selection = new vscode.Selection(1, 0, 1, 6);
    editor.selection = selection;
    const diagnostics = vscode.languages.createDiagnosticCollection('reach-host-smoke');
    diagnostics.set(file, [new vscode.Diagnostic(new vscode.Range(1, 0, 1, 6), 'Host smoke diagnostic', vscode.DiagnosticSeverity.Warning)]);
    const snapshot = await bridge.snapshot();
    assert.equal(snapshot.editor.editors.active.document.dirty, true);
    assert.equal(snapshot.editor.editors.active.selections[0].start.line, 2);
    assert.ok(snapshot.editor.counts.extensions > 0);
    checks.push('Live unsaved buffer, selection and extension inventory');
    const issues = JSON.parse(await bridge.run({ action: 'vscode', topic: 'diagnostics', query: 'example.js' }));
    assert.ok(issues.diagnostics.some(item => item.message === 'Host smoke diagnostic'));
    checks.push('Real VS Code diagnostic collection');
    const extensions = JSON.parse(await bridge.run({ action: 'vscode', topic: 'extensions', extensionId: extension.id }));
    assert.equal(extensions.extensions[0].id, extension.id);
    assert.ok(extensions.extensions[0].contributes.commands.some(item => item.id === 'simplereach.inspectContext'));
    checks.push('Live installed extension manifest and contributed commands');
    let git;
    for (let attempt = 0; attempt < 80; attempt++) {
      git = await bridge.git.snapshot();
      if (git.repositories?.length) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(git.status, 'ok', JSON.stringify(git));
    assert.ok(git.repositories.length > 0, 'Built-in Git discovered fixture repository');
    const repo = git.repositories.find(item => path.resolve(item.root) === path.resolve(root.fsPath));
    assert.ok(repo, 'Workspace root matches built-in Git repository');
    assert.ok(JSON.stringify(repo).includes('https://github.com/reach-fixture/sample/pulls'));
    assert.ok(!JSON.stringify(repo).includes('fixture-token'));
    checks.push('Built-in Git repository, branch and sanitized PR locations');
    const tasks = JSON.parse(await bridge.run({ action: 'vscode', topic: 'tasks', query: 'REACH smoke' }));
    assert.ok(tasks.tasks.some(task => task.name === 'REACH smoke task'));
    checks.push('Workspace task discovery without execution');
    const opened = JSON.parse(await bridge.run({ action: 'open', path: 'example.js', line: 2, column: 1 }));
    assert.equal(opened.opened, true);
    assert.equal(document.isDirty, true);
    checks.push('Native editor navigation preserves unsaved text');
    const provided = await bridge.prepare({ messages: [{ role: 'user', content: 'Describe my editor' }], includeWorkspace: true, agentic: true }, () => {});
    assert.ok(provided.messages.some(message => message.content.includes('REACH live VS Code context')));
    assert.ok(provided.messages.some(message => message.content.includes('pullRequests')));
    checks.push('Agent payload receives live context and tool contracts without a model request');
    const reviewed = await vscode.commands.executeCommand('simplereach.inspectContext');
    assert.ok(reviewed.editor && reviewed.git);
    checks.push('REACH: Inspect VS Code Context opens a native JSON review document');
    diagnostics.dispose();
    fs.writeFileSync(reportPath, JSON.stringify({ ok: true, vscode: vscode.version, extension: extension.packageJSON.version, checks }, null, 2));
  } catch (error) {
    fs.writeFileSync(reportPath, JSON.stringify({ ok: false, checks, error: error.stack }, null, 2));
    throw error;
  }
}

module.exports = { run };
