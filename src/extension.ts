import { ExtensionContext, window, workspace } from 'vscode';

import { createPixiApi, PixiExtensionApi } from './api';
import { registerLogger } from './common/logging';
import { setPersistentState } from './common/persistentState';
import { clearPixiCache, validatePixiCli } from './core/cli';
import { PixiProjectManager } from './core/projectManager';
import { PixiTaskProvider } from './core/taskProvider';
import { PixiTerminalProvider } from './core/terminalProvider';
import { registerWorkspaceCommands } from './core/workspaceCommands';
import { activatePythonSupport } from './languages/python';

export async function activate(context: ExtensionContext): Promise<PixiExtensionApi> {
    const log = window.createOutputChannel('Pixi', { log: true });
    context.subscriptions.push(log, registerLogger(log));

    // Setup persistent state for workspace
    setPersistentState(context);

    // 1. Initialize Pixi Core
    const projectManager = new PixiProjectManager(log);
    context.subscriptions.push(projectManager);

    const taskProvider = new PixiTaskProvider(projectManager, log);
    context.subscriptions.push(taskProvider, taskProvider.registerCommands());

    const terminalProvider = new PixiTerminalProvider(projectManager, log);
    context.subscriptions.push(terminalProvider);

    const workspaceCommands = registerWorkspaceCommands(projectManager);
    context.subscriptions.push(workspaceCommands);

    // 2. Conditionally activate Python support (if ms-python.vscode-python-envs is available)
    const pythonSupport = await activatePythonSupport(projectManager, log);
    if (pythonSupport) {
        context.subscriptions.push(...pythonSupport.disposables);
    }

    // 3. React to configuration changes
    context.subscriptions.push(
        workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('pixi.executablePath')) {
                clearPixiCache();
                if (await validatePixiCli()) {
                    await projectManager.refresh(undefined);
                }
            }
        }),
    );

    // 4. Initial validation if workspace has Pixi projects
    await projectManager.initialize();
    if (projectManager.getProjectPaths().length > 0) {
        await validatePixiCli();
    }

    // 5. Return public Extension API
    return createPixiApi(projectManager);
}
