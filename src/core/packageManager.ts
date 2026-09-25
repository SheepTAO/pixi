import { runPixi } from '../cli/pixiCli';
import { traceError } from '../common/logging';
import { PixiPackage } from './types';

export { PixiPackage };

/**
 * Executes 'pixi list' and returns all packages for the specified environment.
 */
export async function listPixiPackages(envName: string, projectPath: string): Promise<PixiPackage[]> {
    try {
        const stdout = await runPixi(['list', '--no-install', '--frozen', '--json', '--environment', envName], {
            cwd: projectPath,
        });
        return JSON.parse(stdout);
    } catch (error) {
        traceError(`Failed to list packages for environment '${envName}' in ${projectPath}:`, error);
        return [];
    }
}
