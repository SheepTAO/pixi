import semver from 'semver';
import { commands, ExtensionContext, window, workspace } from 'vscode';

import { registerLogger, traceError } from './common/logging';
import { setPersistentState } from './common/persistentState';
import { getPixi, runPixi } from './pixi/cli';
import { PixiEnvManager } from './pixi/envManager';
import { PixiPackageManager } from './pixi/packageManager';
import { PixiTaskProvider } from './pixi/taskProvider';
import { getEnvExtApi } from './pythonEnvsApi';

const MINIMUM_PIXI_VERSION = '0.53.0';

async function validatePixi(): Promise<boolean> {
    try {
        const stdout = await runPixi(['--version']);
        const versionMatch = stdout.trim().match(/^pixi (\d+\.\d+\.\d+)/);
        if (!versionMatch) {
            window.showErrorMessage(`Found invalid Pixi binary at "${await getPixi()}".`);
            return false;
        }

        const currentVersion = versionMatch[1];
        if (!semver.gte(currentVersion, MINIMUM_PIXI_VERSION)) {
            window.showErrorMessage(
                `Pixi version ${currentVersion} is too old. Requires >= ${MINIMUM_PIXI_VERSION}. Run: pixi self-update`,
            );
            return false;
        }
        return true;
    } catch (err) {
        traceError('Pixi validation failed:', err);
        const choice = await window.showErrorMessage(
            'Pixi executable not found. Please install Pixi or set "pixi-python.pixiExecutable" in settings.',
            'Open Settings',
        );
        if (choice === 'Open Settings') {
            commands.executeCommand('workbench.action.openSettings', 'pixi-python.pixiExecutable');
        }
        return false;
    }
}

export async function activate(context: ExtensionContext) {
    const api = await getEnvExtApi();

    const log = window.createOutputChannel('Pixi Environment Manager', { log: true });
    context.subscriptions.push(log, registerLogger(log));

    // Setup the persistent state for the extension.
    setPersistentState(context);

    const manager = new PixiEnvManager(api, log);
    context.subscriptions.push(manager, api.registerEnvironmentManager(manager));

    const packageManager = new PixiPackageManager(api, log, manager);
    context.subscriptions.push(api.registerPackageManager(packageManager));

    const taskProvider = new PixiTaskProvider(manager, log);
    context.subscriptions.push(taskProvider, taskProvider.registerCommands());

    // Re-validate and refresh when pixiExecutable setting changes
    context.subscriptions.push(
        workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('pixi-python.pixiExecutable')) {
                if (await validatePixi()) {
                    await manager.refresh(undefined);
                }
            }
        }),
    );

    // Initial validation
    await validatePixi();
}
