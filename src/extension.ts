import { ExtensionContext, window, workspace } from 'vscode';

import { createPixiApi, PixiExtensionApi } from './api';
import { clearGlobalManifestCache } from './cli/globalCli';
import { clearPixiCache, validatePixiCli } from './cli/pixiCli';
import { registerGlobalCommands } from './commands/globalCommands';
import { registerWorkspaceCommands } from './commands/workspaceCommands';
import { registerLogger } from './common/logging';
import { setPersistentState } from './common/persistentState';
import { PixiProjectManager } from './core/projectManager';
import { activatePythonSupport } from './languages/python';
import { PixiTaskProvider } from './providers/taskProvider';
import { PixiTerminalProvider } from './providers/terminalProvider';
import { PixiGlobalTreeDataProvider } from './views/globalTreeDataProvider';
import { PixiProjectsTreeDataProvider } from './views/projectsTreeDataProvider';
import { PixiStatusBarController } from './views/statusBar';

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

    const globalCommands = registerGlobalCommands();
    context.subscriptions.push(globalCommands);

    // 2. Register Tree Views & Status Bar
    const projectsTreeDataProvider = new PixiProjectsTreeDataProvider(projectManager);
    const projectsTreeView = window.createTreeView('pixi.views.projects', {
        treeDataProvider: projectsTreeDataProvider,
    });
    projectsTreeDataProvider.bindView(projectsTreeView);

    context.subscriptions.push(projectsTreeDataProvider, projectsTreeView);

    const globalTreeDataProvider = new PixiGlobalTreeDataProvider();
    context.subscriptions.push(
        globalTreeDataProvider,
        window.registerTreeDataProvider('pixi.views.global', globalTreeDataProvider),
    );

    const statusBarController = new PixiStatusBarController(projectManager);
    context.subscriptions.push(statusBarController);

    // 3. Conditionally activate Python support (if ms-python.vscode-python-envs is available)
    const pythonSupport = await activatePythonSupport(projectManager, log);
    if (pythonSupport) {
        context.subscriptions.push(...pythonSupport.disposables);
    }

    // 3. React to configuration changes
    context.subscriptions.push(
        workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('pixi.executablePath')) {
                clearPixiCache();
                clearGlobalManifestCache();
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
