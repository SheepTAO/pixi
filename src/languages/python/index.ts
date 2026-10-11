import { PythonEnvironmentApi } from '@vscode/python-environments';
import { Disposable, extensions } from 'vscode';

import { PixiExtensionApi } from '../../api';
import { traceError, traceInfo } from '../../common/logging';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiPythonEnvManager } from './pythonEnvManager';
import { PixiPythonPackageManager } from './pythonPackageManager';

export async function activatePythonSupport(
    projectManager: PixiProjectManager,
    pixiApi: PixiExtensionApi,
): Promise<Disposable[]> {
    const pythonEnvsExt = extensions.getExtension('ms-python.vscode-python-envs');
    if (!pythonEnvsExt) {
        traceInfo('ms-python.vscode-python-envs not found. Python environment integration will remain inactive.');
        return [];
    }

    try {
        const api = (
            pythonEnvsExt.isActive ? pythonEnvsExt.exports : await pythonEnvsExt.activate()
        ) as PythonEnvironmentApi;

        const envManager = new PixiPythonEnvManager(api, projectManager, pixiApi);
        const packageManager = new PixiPythonPackageManager(api, envManager, projectManager);

        const disposables: Disposable[] = [
            envManager,
            api.registerEnvironmentManager(envManager),
            packageManager,
            api.registerPackageManager(packageManager),
        ];

        await envManager.initialize();
        traceInfo('Pixi Python environment integration activated successfully.');

        return disposables;
    } catch (error) {
        traceError('Failed to activate Pixi Python environment integration:', error);
        return [];
    }
}
