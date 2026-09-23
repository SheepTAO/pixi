import { EnvironmentGroupInfo, PythonEnvironment } from '@vscode/python-environments';
import * as fs from 'fs';
import * as path from 'path';
import { MarkdownString, ThemeIcon, Uri, window, workspace } from 'vscode';

import { findPythonExecutable } from '../common/findPython';
import { traceInfo, traceVerbose } from '../common/logging';
import { PIXI_MANAGER_ID } from '../common/utils';
import { _runPixi, getPixi } from './cli';
import { PixiEnvironment, PixiInfo } from './types';

export const READY_GROUP: EnvironmentGroupInfo = {
    name: 'Ready',
    description: 'Available Python environments',
};

export const UNAVAILABLE_GROUP: EnvironmentGroupInfo = {
    name: 'Unavailable',
    description: 'Incompatible or uninstalled environments',
    iconPath: new ThemeIcon('warning'),
};

export function sortEnvironments<T extends PythonEnvironment>(envs: T[]): T[] {
    return envs.sort((a, b) => {
        const aReady = !('error' in a && a.error);
        const bReady = !('error' in b && b.error);
        if (aReady !== bReady) {
            return aReady ? -1 : 1;
        }
        return a.displayName.localeCompare(b.displayName);
    });
}

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

export async function pickManifestFormat(): Promise<'pixi' | 'pyproject' | undefined> {
    const pick = await window.showQuickPick(
        [
            {
                label: '$(file-code) pixi.toml',
                description: 'Dedicated Pixi manifest format (Recommended)',
                format: 'pixi' as const,
            },
            {
                label: '$(file) pyproject.toml',
                description: 'Standard Python pyproject.toml format',
                format: 'pyproject' as const,
            },
        ],
        { placeHolder: 'Select manifest format for the new Pixi project' },
    );
    return pick?.format;
}

export function isPixiProject(folderPath: string): boolean {
    return (
        fs.existsSync(path.join(folderPath, 'pixi.toml')) ||
        fs.existsSync(path.join(folderPath, 'pyproject.toml')) ||
        fs.existsSync(path.join(folderPath, '.pixi'))
    );
}

export function formatDisplayName(
    template: string,
    projectName: string,
    envName: string,
    pythonVersion?: string,
): string {
    const defaultName = projectName ? `${projectName}:${envName}` : envName || 'default';
    const raw = (template || '${project}:${env}')
        .replace(/(\$\{|\{\{)project(\}|\}\})/g, projectName || '')
        .replace(/(\$\{|\{\{)env(\}|\}\})/g, envName || '')
        .replace(/(\$\{|\{\{)(python|version)(\}|\}\})/g, pythonVersion || '')
        .replace(/(\$\{|\{\{)[^}]+(\}|\}\})/g, '');

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
        const currentPlatform = pixiInfo.platform;
        const template =
            workspace.getConfiguration('pixi-python', Uri.file(projectPath)).get<string>('displayNameFormat') ||
            '${project}:${env}';

        const results = await Promise.all(
            pixiInfo.environments_info.map(async (pixiEnv) => {
                const platformNames = (pixiEnv.platforms || []).map((p) => (typeof p === 'string' ? p : p.name));
                const isPlatformSupported =
                    !currentPlatform ||
                    platformNames.length === 0 ||
                    pixiEnv.platforms!.some((p) =>
                        typeof p === 'string'
                            ? p === currentPlatform
                            : p.subdir === currentPlatform || p.name === currentPlatform,
                    );

                let error: string | undefined;
                let statusDesc = 'pixi';
                let pythonExecutable = '';
                let pythonVersion = '';

                if (!isPlatformSupported) {
                    error = `Environment '${pixiEnv.name}' declared platforms [${platformNames.join(', ')}], which is incompatible with current host platform '${currentPlatform}'.`;
                    statusDesc = 'pixi (incompatible)';
                } else if (!fs.existsSync(pixiEnv.prefix)) {
                    error = `Environment '${pixiEnv.name}' is not installed yet on disk. Run 'pixi install -e ${pixiEnv.name}' to create it.`;
                    statusDesc = 'pixi (not installed)';
                } else {
                    pythonExecutable = (await findPythonExecutable(pixiEnv.prefix)) || '';
                    pythonVersion = (await findPythonVersionFromMeta(pixiEnv.prefix)) || '';
                    if (!pythonExecutable) {
                        error = `No Python executable found in environment '${pixiEnv.name}'. Ensure 'python' dependency is added to the environment.`;
                        statusDesc = 'pixi (no python)';
                    }
                }

                const displayName = formatDisplayName(template, projectName, pixiEnv.name, pythonVersion);
                const isReady = !error;

                let tooltip: string | MarkdownString;
                if (error) {
                    const md = new MarkdownString(
                        `**${displayName}**\n\n$(warning) **Status**: ${error}\n\n*Prefix*: \`${pixiEnv.prefix}\``,
                    );
                    md.supportThemeIcons = true;
                    tooltip = md;
                } else {
                    tooltip = pythonExecutable;
                }

                return {
                    name: displayName,
                    displayName,
                    shortDisplayName: pixiEnv.name,
                    displayPath: pixiEnv.prefix,
                    version: pythonVersion,
                    environmentPath: Uri.file(pixiEnv.prefix),
                    description: statusDesc,
                    tooltip,
                    iconPath: isReady ? new ThemeIcon('python') : new ThemeIcon('warning'),
                    group: isReady ? READY_GROUP : UNAVAILABLE_GROUP,
                    error,
                    execInfo: {
                        run: { executable: pythonExecutable || 'python' },
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

        return sortEnvironments(results);
    } catch (error) {
        traceInfo(`Failed to get pixi environments: ${error}`);
        return [];
    }
}
