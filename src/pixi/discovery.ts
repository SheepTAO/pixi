import * as fs from 'fs';
import * as path from 'path';
import { ThemeIcon, Uri, workspace } from 'vscode';

import { findPythonExecutable } from '../common/findPython';
import { traceInfo, traceVerbose } from '../common/logging';
import { PIXI_MANAGER_ID } from '../common/utils';
import { _runPixi, getPixi } from './cli';
import { PixiEnvironment, PixiInfo } from './types';

export async function findPythonVersionFromMeta(prefix: string): Promise<string | undefined> {
    try {
        const metaDir = path.join(prefix, 'conda-meta');
        const stats = await fs.promises.stat(metaDir).catch(() => null);
        if (stats?.isDirectory()) {
            const files = await fs.promises.readdir(metaDir);
            for (const file of files) {
                const match = file.match(/^python-(\d[^-]*)-.*\.json$/);
                if (match) {
                    return match[1];
                }
            }
        }
    } catch {
        // ignore
    }
    return undefined;
}

export function formatDisplayName(
    template: string,
    projectName: string,
    envName: string,
    pythonVersion?: string,
): string {
    const defaultName = projectName ? `${projectName}:${envName}` : envName || 'default';
    const raw = (template || '${project}:${env}')
        .replace(/\$\{project\}/g, projectName || '')
        .replace(/\$\{env\}/g, envName || '')
        .replace(/\$\{(python|version)\}/g, pythonVersion || '')
        .replace(/\$\{[^}]+\}/g, '');

    const cleaned = raw
        .replace(/\(\s*\)/g, '')
        .replace(/\[\s*\]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[ \t\-_:/|]+|[ \t\-_:/|]+$/g, '')
        .trim();

    return cleaned || defaultName;
}

export async function refreshPixi(projectPath: string): Promise<PixiEnvironment[]> {
    try {
        const pixi = await getPixi();
        const stdout = await _runPixi(pixi, ['info', '--json'], { cwd: projectPath });
        const pixiInfo: PixiInfo = JSON.parse(stdout);

        if (!pixiInfo.project_info) {
            traceVerbose(`No project info found for Pixi project at ${projectPath}`);
            return [];
        }

        const projectName = pixiInfo.project_info.name;
        const manifestPath = pixiInfo.project_info.manifest_path;
        const template =
            workspace.getConfiguration('pixi-python', Uri.file(projectPath)).get<string>('displayNameFormat') ||
            '${project}:${env}';

        const results = await Promise.all(
            pixiInfo.environments_info.map(async (pixiEnv) => {
                const pythonExecutable = (await findPythonExecutable(pixiEnv.prefix)) || '';
                if (!pythonExecutable) {
                    return null;
                }

                const pythonVersion = (await findPythonVersionFromMeta(pixiEnv.prefix)) || '';
                const displayName = formatDisplayName(template, projectName, pixiEnv.name, pythonVersion);

                return {
                    name: displayName,
                    displayName,
                    shortDisplayName: pixiEnv.name,
                    displayPath: pixiEnv.prefix,
                    version: pythonVersion,
                    environmentPath: Uri.file(pixiEnv.prefix),
                    description: 'pixi',
                    tooltip: pythonExecutable,
                    iconPath: new ThemeIcon('python'),
                    execInfo: {
                        run: { executable: pythonExecutable },
                        activatedRun: {
                            executable: pixi,
                            args: ['run', '--manifest-path', manifestPath, '-e', pixiEnv.name, 'python'],
                        },
                        activation: [
                            {
                                executable: pixi,
                                args: ['shell', '--manifest-path', manifestPath, '-e', pixiEnv.name],
                            },
                        ],
                        deactivation: [{ executable: 'exit', args: [] }],
                    },
                    sysPrefix: pixiEnv.prefix,
                    envId: {
                        id: pixiEnv.prefix,
                        managerId: PIXI_MANAGER_ID,
                    },
                    pixiInfo,
                    packages: [],
                    pixiEnvName: pixiEnv.name,
                } as PixiEnvironment;
            }),
        );

        return results.filter((env): env is PixiEnvironment => env !== null);
    } catch (error) {
        traceInfo(`Failed to get pixi environments: ${error}`);
        return [];
    }
}
