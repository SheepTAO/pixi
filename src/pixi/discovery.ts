import { EnvironmentGroupInfo, PythonEnvironment } from '@vscode/python-environments';
import * as fs from 'fs';
import * as path from 'path';
import { MarkdownString, ThemeIcon, Uri, window, workspace } from 'vscode';

import { findPythonExecutable } from '../common/findPython';
import { traceInfo, traceVerbose } from '../common/logging';
import { PIXI_MANAGER_ID } from '../common/utils';
import { _runPixi, getPixi } from './cli';
import { PixiEnvironment, PixiEnvironmentStatus, PixiInfo } from './types';

export const UNAVAILABLE_GROUP: EnvironmentGroupInfo = {
    name: 'Unavailable',
    description: 'Incompatible or broken environments',
    iconPath: new ThemeIcon('circle-slash'),
};

export function getEnvironmentPriority(env: PythonEnvironment): number {
    const pixiEnv = env as PixiEnvironment;
    if (pixiEnv.pixiStatus === 'ready') {
        return 0;
    }
    if (pixiEnv.pixiStatus === 'cache') {
        return 1;
    }
    if (pixiEnv.pixiStatus === 'unable') {
        return 2;
    }
    if (!('error' in env && env.error)) {
        return 0;
    }
    return env.error.includes('not installed') ? 1 : 2;
}

export interface EnvironmentQuickPickInfo {
    icon: string;
    statusText?: string;
}

export function getEnvironmentQuickPickInfo(env: PythonEnvironment): EnvironmentQuickPickInfo {
    const pixiEnv = env as PixiEnvironment;
    if (pixiEnv.pixiStatus === 'cache' || (!pixiEnv.pixiStatus && env.error?.includes('not installed'))) {
        return { icon: '$(cloud-download)', statusText: '(not installed)' };
    }
    if (pixiEnv.pixiStatus === 'unable' || (!pixiEnv.pixiStatus && env.error)) {
        return { icon: '$(circle-slash)', statusText: '(unavailable)' };
    }
    return { icon: '$(python)' };
}

export function sortEnvironments<T extends PythonEnvironment>(envs: T[]): T[] {
    return envs.sort((a, b) => {
        const pA = getEnvironmentPriority(a);
        const pB = getEnvironmentPriority(b);
        if (pA !== pB) {
            return pA - pB;
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
    if (fs.existsSync(path.join(folderPath, 'pixi.toml')) || fs.existsSync(path.join(folderPath, '.pixi'))) {
        return true;
    }
    const pyprojectPath = path.join(folderPath, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
        try {
            const content = fs.readFileSync(pyprojectPath, 'utf8');
            return /(?:^|\n)\s*\[tool\.pixi/.test(content);
        } catch {
            return false;
        }
    }
    return false;
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
                let pixiStatus: PixiEnvironmentStatus = 'ready';

                if (!isPlatformSupported) {
                    error = `Environment '${pixiEnv.name}' declared platforms [${platformNames.join(', ')}], which is incompatible with current host platform '${currentPlatform}'.`;
                    statusDesc = 'pixi (incompatible)';
                    pixiStatus = 'unable';
                } else if (!fs.existsSync(pixiEnv.prefix)) {
                    error = `Environment '${pixiEnv.name}' is not installed yet on disk. Run 'pixi install -e ${pixiEnv.name}' to create it.`;
                    statusDesc = 'pixi (not installed)';
                    pixiStatus = 'cache';
                } else {
                    pythonExecutable = (await findPythonExecutable(pixiEnv.prefix)) || '';
                    pythonVersion = (await findPythonVersionFromMeta(pixiEnv.prefix)) || '';
                    if (!pythonExecutable) {
                        error = `No Python executable found in environment '${pixiEnv.name}'. Ensure 'python' dependency is added to the environment.`;
                        statusDesc = 'pixi (no python)';
                        pixiStatus = 'unable';
                    }
                }

                const displayName = formatDisplayName(template, projectName, pixiEnv.name, pythonVersion);

                let tooltip: string | MarkdownString;
                let iconPath: ThemeIcon;
                if (pixiStatus === 'cache') {
                    const md = new MarkdownString(
                        `**${displayName}**\n\n$(cloud-download) **Status**: Compatible with host platform, but not installed yet on disk. Click to install.\n\n*Prefix*: \`${pixiEnv.prefix}\``,
                    );
                    md.supportThemeIcons = true;
                    tooltip = md;
                    iconPath = new ThemeIcon('cloud-download');
                } else if (pixiStatus === 'unable') {
                    const md = new MarkdownString(
                        `**${displayName}**\n\n$(circle-slash) **Status**: ${error}\n\n*Prefix*: \`${pixiEnv.prefix}\``,
                    );
                    md.supportThemeIcons = true;
                    tooltip = md;
                    iconPath = new ThemeIcon('circle-slash');
                } else {
                    tooltip = pythonExecutable;
                    iconPath = new ThemeIcon('python');
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
                    iconPath,
                    group: pixiStatus === 'unable' ? UNAVAILABLE_GROUP : undefined,
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
                    pixiStatus,
                } as PixiEnvironment;
            }),
        );

        return sortEnvironments(results);
    } catch (error) {
        traceInfo(`Failed to get pixi environments: ${error}`);
        return [];
    }
}
