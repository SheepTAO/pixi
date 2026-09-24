import { PythonEnvironmentApi } from '@vscode/python-environments';
import { Disposable, extensions, LogOutputChannel } from 'vscode';

import { traceError, traceInfo } from '../../common/logging';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiPythonEnvManager } from './pythonEnvManager';
import { PixiPythonPackageManager } from './pythonPackageManager';

export async function activatePythonSupport(
    projectManager: PixiProjectManager,
    log?: LogOutputChannel,
): Promise<{ disposables: Disposable[]; envManager: PixiPythonEnvManager } | undefined> {
    const pythonEnvsExt = extensions.getExtension('ms-python.vscode-python-envs');
    if (!pythonEnvsExt) {
        traceInfo('ms-python.vscode-python-envs not found. Python environment integration will remain inactive.');
        return undefined;
    }

    try {
        let api: PythonEnvironmentApi;
        if (pythonEnvsExt.isActive) {
            api = pythonEnvsExt.exports as PythonEnvironmentApi;
        } else {
            api = (await pythonEnvsExt.activate()) as PythonEnvironmentApi;
        }

        const envManager = new PixiPythonEnvManager(api, projectManager, log);
        const packageManager = new PixiPythonPackageManager(api, log, envManager, projectManager);

        const disposables: Disposable[] = [
            envManager,
            api.registerEnvironmentManager(envManager),
            packageManager,
            api.registerPackageManager(packageManager),
        ];

        await envManager.initialize();
        traceInfo('Pixi Python environment integration activated successfully.');

        return { disposables, envManager };
    } catch (error) {
        traceError('Failed to activate Pixi Python environment integration:', error);
        return undefined;
    }
}
