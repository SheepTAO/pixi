import { ExtensionContext, window, workspace } from 'vscode';

import { createPixiApi, PixiExtensionApi } from './api';
import { clearPixiCache, validatePixiCli } from './cli/pixiCli';
import { registerAuthCommands } from './commands/authCommands';
import { registerConfigCommands } from './commands/configCommands';
import { registerGlobalCommands } from './commands/globalCommands';
import { registerInfoCommands } from './commands/infoCommands';
import { registerWorkspaceCommands } from './commands/workspace';
import { registerLogger, traceInfo } from './common/logging';
import { setPersistentState } from './common/persistentState';
import { PixiPackageUpdateService } from './core/packageUpdateService';
import { PixiProjectManager } from './core/projectManager';
import { activatePythonSupport } from './languages/python';
import { PixiDependencyManifestProvider } from './providers/dependencyManifestProvider';
import { PixiManifestSchemaProvider } from './providers/manifestSchemaProvider';
import { PixiTaskManifestProvider } from './providers/taskManifestProvider';
import { PixiTaskProvider } from './providers/taskProvider';
import { PixiTerminalProvider } from './providers/terminalProvider';
import { PixiGlobalTreeDataProvider } from './views/globalTreeDataProvider';
import { PixiInfoTreeDataProvider } from './views/infoTreeDataProvider';
import { PixiProjectsTreeDataProvider } from './views/projectsTreeDataProvider';
import { PixiTasksTreeDataProvider } from './views/tasksTreeDataProvider';

export async function activate(context: ExtensionContext): Promise<PixiExtensionApi> {
    const log = window.createOutputChannel('Pixi', { log: true });
    context.subscriptions.push(log, registerLogger(log));

    // Setup persistent state for workspace
    setPersistentState(context);

    // 1. Initialize Pixi Core & Public API
    const projectManager = new PixiProjectManager();
    context.subscriptions.push(projectManager);

    const packageUpdateService = new PixiPackageUpdateService(projectManager);
    context.subscriptions.push(packageUpdateService);

    const extensionVersion: string = context.extension.packageJSON.version;
    const pixiApi = createPixiApi(projectManager, extensionVersion);
    context.subscriptions.push(pixiApi);

    const taskProvider = new PixiTaskProvider(projectManager);
    context.subscriptions.push(taskProvider);

    const taskManifestProvider = new PixiTaskManifestProvider(projectManager, taskProvider);
    context.subscriptions.push(taskManifestProvider);

    const dependencyManifestProvider = new PixiDependencyManifestProvider(
        projectManager,
        pixiApi,
        packageUpdateService,
    );
    context.subscriptions.push(dependencyManifestProvider);

    const manifestSchemaProvider = new PixiManifestSchemaProvider(context);
    context.subscriptions.push(manifestSchemaProvider);

    const terminalProvider = new PixiTerminalProvider(projectManager, context, pixiApi);
    context.subscriptions.push(terminalProvider);

    const workspaceCommands = registerWorkspaceCommands(projectManager, taskProvider, packageUpdateService);
    context.subscriptions.push(workspaceCommands);

    const globalCommands = registerGlobalCommands();
    context.subscriptions.push(globalCommands);

    const configCommands = registerConfigCommands(projectManager);
    context.subscriptions.push(configCommands);

    // 2. Register Tree Views
    const projectsTreeDataProvider = new PixiProjectsTreeDataProvider(projectManager, packageUpdateService);
    const projectsTreeView = window.createTreeView('pixi.views.projects', {
        treeDataProvider: projectsTreeDataProvider,
    });
    projectsTreeDataProvider.bindView(projectsTreeView);

    context.subscriptions.push(projectsTreeDataProvider, projectsTreeView);

    const tasksTreeDataProvider = new PixiTasksTreeDataProvider(projectManager, taskProvider);
    const tasksTreeView = window.createTreeView('pixi.views.tasks', {
        treeDataProvider: tasksTreeDataProvider,
    });

    context.subscriptions.push(tasksTreeDataProvider, tasksTreeView);

    const globalTreeDataProvider = new PixiGlobalTreeDataProvider();
    context.subscriptions.push(
        globalTreeDataProvider,
        window.registerTreeDataProvider('pixi.views.global', globalTreeDataProvider),
    );

    const infoTreeDataProvider = new PixiInfoTreeDataProvider();
    context.subscriptions.push(
        infoTreeDataProvider,
        window.registerTreeDataProvider('pixi.views.info', infoTreeDataProvider),
        registerInfoCommands(infoTreeDataProvider),
        registerAuthCommands(infoTreeDataProvider),
    );

    traceInfo(`Pixi extension v${extensionVersion} activated.`);

    // 4. Concurrently initialize Python support and project discovery
    const pythonSupportPromise = activatePythonSupport(projectManager, pixiApi);

    const projectInitPromise = (async () => {
        await projectManager.initialize();
        const projects = projectManager.getProjects();
        if (projects.length > 0) {
            await validatePixiCli();
            for (const p of projects) {
                const envs = projectManager.getEnvironmentsForProject(p.projectPath);
                const envNames = envs.map((e) => e.pixiEnvName).join(', ');
                traceInfo(`Discovered Pixi project: ${p.name} [${envs.length} envs: ${envNames || 'none'}]`);
            }
        } else {
            traceInfo('No Pixi projects discovered in current workspace.');
        }
    })();

    const [pythonDisposables] = await Promise.all([
        pythonSupportPromise,
        projectInitPromise,
    ]);

    context.subscriptions.push(...pythonDisposables);

    // 6. React to configuration changes
    context.subscriptions.push(
        workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('pixi.executablePath')) {
                clearPixiCache();
                infoTreeDataProvider.refresh();
                if (await validatePixiCli()) {
                    await projectManager.refresh(undefined);
                }
            }
            if (e.affectsConfiguration('pixi.cache.autoMeasureSize')) {
                infoTreeDataProvider.refresh();
            }
        }),
    );

    // 7. Return public Extension API
    return pixiApi;
}
