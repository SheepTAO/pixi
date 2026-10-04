import * as fs from 'fs';
import * as path from 'path';
import { MarkdownString, ThemeIcon, Uri, window } from 'vscode';

import { runPixiWithProgress } from '../../cli/workspaceCli';
import { promptToInstallEnvironment as promptCoreInstall } from '../../core/environmentRules';
import { PixiProjectManager } from '../../core/projectManager';
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
    const projectFolder = env.manifestPath ? Uri.file(path.dirname(env.manifestPath)) : undefined;
    const folder = targetFolder ?? projectFolder ?? env.environmentPath;
    return promptCoreInstall(env.pixiEnvName, folder);
}

export async function promptToInstallIpykernel(
    env: PixiPythonEnvironment,
    projectManager: PixiProjectManager,
    altEnvs?: PixiPythonEnvironment[],
    onSwitch?: (target: PixiPythonEnvironment) => Promise<void>,
): Promise<boolean> {
    const altWithKernel = altEnvs?.find(
        (e) => e.hasIpykernel && e.pixiEnvName !== env.pixiEnvName && e.pixiStatus === 'installed',
    );
    const msg = `Pixi environment '${env.pixiEnvName}' does not have 'ipykernel' installed. Jupyter cannot execute notebook cells with this kernel until ipykernel is added.`;
    const actions: string[] = ['Install ipykernel via Pixi'];
    if (altWithKernel) {
        actions.push(`Switch to '${altWithKernel.pixiEnvName}'`);
    }

    const selected = await window.showWarningMessage(msg, ...actions);
    if (selected === 'Install ipykernel via Pixi') {
        const args = ['add'];
        if (env.pixiEnvName !== 'default') {
            args.push('-e', env.pixiEnvName);
        }
        args.push('ipykernel');
        const title = `Pixi: Adding 'ipykernel' to environment '${env.pixiEnvName}' in '${env.projectName}'...`;
        const successMsg = `Pixi: Successfully added ipykernel to environment '${env.pixiEnvName}'.`;
        return runPixiWithProgress(title, args, env.projectPath, projectManager, successMsg);
    } else if (altWithKernel && selected === `Switch to '${altWithKernel.pixiEnvName}'`) {
        if (onSwitch) {
            await onSwitch(altWithKernel);
            return true;
        }
    }
    return false;
}

function checkHasIpykernel(envPath: string): boolean {
    const kernelSpec = path.join(envPath, 'share', 'jupyter', 'kernels', 'python3', 'kernel.json');
    if (fs.existsSync(kernelSpec)) {
        return true;
    }
    const binPath =
        process.platform === 'win32'
            ? path.join(envPath, 'Scripts', 'ipykernel.exe')
            : path.join(envPath, 'bin', 'ipykernel');
    if (fs.existsSync(binPath)) {
        return true;
    }
    const metaDir = path.join(envPath, 'conda-meta');
    try {
        if (fs.existsSync(metaDir)) {
            const files = fs.readdirSync(metaDir);
            return files.some((f) => f.startsWith('ipykernel-') && f.endsWith('.json'));
        }
    } catch {
        // ignore
    }
    return false;
}

const PRIORITY_MAP: Record<string, number> = {
    installed: 0,
    uninstalled: 1,
    incompatible: 2,
};

export function getEnvironmentPriority(env: PixiPythonEnvironment): number {
    if (env.error) {
        return env.error.includes('not installed') ? 1 : 2;
    }
    return PRIORITY_MAP[env.pixiStatus] ?? 0;
}

export function sortEnvironments(envs: PixiPythonEnvironment[]): PixiPythonEnvironment[] {
    return [...envs].sort((a, b) => {
        const pA = getEnvironmentPriority(a);
        const pB = getEnvironmentPriority(b);
        if (pA !== pB) {
            return pA - pB;
        }
        const aIsDefault = a.shortDisplayName === 'default';
        const bIsDefault = b.shortDisplayName === 'default';
        if (aIsDefault !== bIsDefault) {
            return aIsDefault ? -1 : 1;
        }
        return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
    });
}

export function formatDisplayName(template: string, projectName: string, envName: string, version?: string): string {
    const defaultName = projectName ? `${projectName}:${envName}` : envName || 'default';
    const vars: Record<string, string | undefined> = {
        project: projectName,
        env: envName,
        version: version,
    };
    const raw = (template || '${project}:${env}').replace(
        /(?:\$\{|\{\{)\s*([^}]+?)\s*(?:\}|\}\})/g,
        (_, key) => vars[key] || '',
    );

    const cleaned = raw
        .replace(/\(\s*v?\s*\)/gi, '')
        .replace(/\[\s*v?\s*\]/gi, '')
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
    let hasIpykernel = false;
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
        hasIpykernel = checkHasIpykernel(coreInfo.prefix);

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
        const kernelTag = hasIpykernel ? ' (ipykernel)' : ' (no ipykernel)';
        tooltip = `${pythonExecutable}${kernelTag}`;
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
        group: 'Pixi',
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
        hasIpykernel,
    };
}
