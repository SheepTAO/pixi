import * as path from 'path';
import { commands, MarkdownString, ThemeIcon, Uri, window } from 'vscode';

import { scanPythonToolchain } from '../../core/toolchains';
import { PixiEnvironmentInfo } from '../../core/types';
import { PIXI_MANAGER_ID } from './constants';
import { PixiPythonEnvironment } from './types';

export function isEnvironmentInvalid(env?: PixiPythonEnvironment): boolean {
    if (!env) {
        return true;
    }
    return env.pixiStatus === 'incompatible' || !!env.error;
}

export async function promptToInstallEnvironment(env: PixiPythonEnvironment, targetFolder?: Uri): Promise<boolean> {
    const action = await window.showWarningMessage(
        `Environment '${env.pixiEnvName}' is not installed yet on disk. Would you like to install it now?`,
        'Install Environment',
    );
    if (action === 'Install Environment') {
        const projectFolder = env.manifestPath ? Uri.file(path.dirname(env.manifestPath)) : undefined;
        const folder = targetFolder ?? projectFolder ?? env.environmentPath;
        void commands.executeCommand('pixi.install', folder, env.pixiEnvName);
        return true;
    }
    return false;
}

export function getEnvironmentPriority(env: PixiPythonEnvironment): number {
    if (env.pixiStatus === 'installed') {
        return 0;
    }
    if (env.pixiStatus === 'uninstalled' || env.error?.includes('not installed')) {
        return 1;
    }
    if (env.pixiStatus === 'incompatible' || env.error) {
        return 2;
    }
    return 0;
}

export interface EnvironmentQuickPickInfo {
    icon: string;
    statusText?: string;
}

export function getEnvironmentQuickPickInfo(env: PixiPythonEnvironment): EnvironmentQuickPickInfo {
    if (env.pixiStatus === 'uninstalled' || env.error?.includes('not installed')) {
        return { icon: '$(cloud-download)', statusText: '(not installed)' };
    }
    if (env.pixiStatus === 'incompatible' || env.error) {
        return { icon: '$(circle-slash)', statusText: '(incompatible)' };
    }
    return { icon: '$(python)' };
}

export function sortEnvironments(envs: PixiPythonEnvironment[]): PixiPythonEnvironment[] {
    return envs.sort((a, b) => {
        const pA = getEnvironmentPriority(a);
        const pB = getEnvironmentPriority(b);
        if (pA !== pB) {
            return pA - pB;
        }
        return a.displayName.localeCompare(b.displayName);
    });
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

export async function createPythonEnvironment(
    coreInfo: PixiEnvironmentInfo,
    pixiBin: string,
    template: string,
): Promise<PixiPythonEnvironment> {
    let pythonExecutable = '';
    let pythonVersion = '';
    let status = coreInfo.pixiStatus;
    let statusReason = coreInfo.statusReason;
    let statusDesc = 'pixi';

    if (status === 'installed') {
        if (coreInfo.toolchains?.python) {
            pythonExecutable = coreInfo.toolchains.python.executable;
            pythonVersion = coreInfo.toolchains.python.version || '';
        } else {
            const py = await scanPythonToolchain(coreInfo.prefix);
            pythonExecutable = py?.executable || '';
            pythonVersion = py?.version || '';
        }

        if (!pythonExecutable) {
            statusReason = `No Python executable found in environment '${coreInfo.pixiEnvName}'. Ensure 'python' dependency is added.`;
            statusDesc = 'pixi (no python)';
            status = 'incompatible';
        }
    } else if (status === 'uninstalled') {
        statusDesc = 'pixi (not installed)';
    } else if (status === 'incompatible') {
        statusDesc = 'pixi (incompatible)';
    }

    const displayName = formatDisplayName(template, coreInfo.projectName, coreInfo.pixiEnvName, pythonVersion);

    let tooltip: string | MarkdownString;
    let iconPath: ThemeIcon;
    if (status === 'uninstalled') {
        const md = new MarkdownString(
            `**${displayName}**\n\n$(cloud-download) **Status**: Compatible with host platform, but not installed yet on disk. Click to install.\n\n*Prefix*: \`${coreInfo.prefix}\``,
        );
        md.supportThemeIcons = true;
        tooltip = md;
        iconPath = new ThemeIcon('cloud-download');
    } else if (status === 'incompatible') {
        const md = new MarkdownString(
            `**${displayName}**\n\n$(circle-slash) **Status**: ${statusReason}\n\n*Prefix*: \`${coreInfo.prefix}\``,
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
        shortDisplayName: coreInfo.pixiEnvName,
        displayPath: coreInfo.prefix,
        version: pythonVersion,
        environmentPath: Uri.file(coreInfo.prefix),
        description: statusDesc,
        tooltip,
        iconPath,
        group: undefined,
        error: undefined,
        execInfo: {
            run: { executable: pythonExecutable || 'python' },
            activatedRun: {
                executable: pixiBin,
                args: ['run', '--manifest-path', coreInfo.manifestPath, '-e', coreInfo.pixiEnvName, 'python'],
            },
            activation: [
                {
                    executable: pixiBin,
                    args: ['shell', '--manifest-path', coreInfo.manifestPath, '-e', coreInfo.pixiEnvName],
                },
            ],
            deactivation: [{ executable: 'exit', args: [] }],
        },
        sysPrefix: coreInfo.prefix,
        envId: {
            id: coreInfo.prefix,
            managerId: PIXI_MANAGER_ID,
        },
        packages: [],
        pixiEnvName: coreInfo.pixiEnvName,
        pixiStatus: status,
        statusReason,
        projectPath: coreInfo.projectPath,
        projectName: coreInfo.projectName,
        manifestPath: coreInfo.manifestPath,
        coreInfo,
    };
}
