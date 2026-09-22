import { Package } from '@vscode/python-environments';
import * as ch from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CancellationError, CancellationToken, ThemeIcon, Uri, workspace } from 'vscode';
import which from 'which';

import { createDeferred } from '../common/deferred';
import { quoteArgs } from '../common/execUtils';
import { findPythonExecutable } from '../common/findPython';
import { traceError, traceInfo, traceVerbose } from '../common/logging';
import { getWorkspacePersistentState } from '../common/persistentState';
import { PIXI_MANAGER_ID, untildify } from '../common/utils';
import { PixiEnvironment, PixiInfo, PixiPackage } from './types';

const PIXI_WORKSPACE_KEY = `${PIXI_MANAGER_ID}:WORKSPACE_SELECTED`;
const PIXI_GLOBAL_KEY = `${PIXI_MANAGER_ID}:GLOBAL_SELECTED`;

async function findPixi(): Promise<string | undefined> {
    try {
        return await which('pixi');
    } catch {
        return undefined;
    }
}

export async function getPixi(): Promise<string> {
    const config = workspace.getConfiguration('pixi-python');
    const value = config.get<string>('pixiExecutable');

    if (value) {
        let resolved = untildify(value);
        if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
            const firstFolder = workspace.workspaceFolders[0].uri.fsPath;
            resolved = resolved.replace(/\$\{workspaceFolder\}/g, firstFolder);
            if (!path.isAbsolute(resolved)) {
                for (const folder of workspace.workspaceFolders) {
                    const candidate = path.resolve(folder.uri.fsPath, resolved);
                    if (fs.existsSync(candidate)) {
                        resolved = candidate;
                        break;
                    }
                }
            }
        }
        return resolved;
    }

    const pixiPath = await findPixi();
    if (!pixiPath) {
        throw new Error(
            'Pixi executable not found. Please install Pixi or set "pixi-python.pixiExecutable" in your settings.',
        );
    }
    return pixiPath;
}

async function _runPixi(
    pixi: string,
    args: string[],
    options?: ch.SpawnOptions,
    token?: CancellationToken,
): Promise<string> {
    const deferred = createDeferred<string>();

    const isWindows = process.platform === 'win32';
    const useShell = isWindows && !pixi.toLowerCase().endsWith('.exe');
    const finalArgs = useShell ? quoteArgs(args) : args;

    const proc = ch.spawn(pixi, finalArgs, {
        shell: useShell,
        windowsHide: true,
        ...options,
    });

    const cancelDisposable = token?.onCancellationRequested(() => {
        proc.kill();
        deferred.reject(new CancellationError());
    });

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;

    proc.stdout?.on('data', (data) => {
        stdout += data.toString('utf-8');
    });
    proc.stderr?.on('data', (data) => {
        const d = data.toString('utf-8');
        stderr += d;
        traceError(d.trim());
    });
    proc.on('error', (err) => {
        deferred.reject(err);
    });
    proc.on('exit', (code) => {
        exitCode = code;
    });
    proc.on('close', () => {
        cancelDisposable?.dispose();
        if (exitCode !== 0) {
            deferred.reject(new Error(`Failed to run "pixi ${args.join(' ')}":\n ${stderr}`));
        } else {
            deferred.resolve(stdout);
        }
    });

    return deferred.promise;
}

export async function runPixi(args: string[], options?: ch.SpawnOptions, token?: CancellationToken): Promise<string> {
    const pixi = await getPixi();
    const defaultCwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
    const spawnOptions: ch.SpawnOptions = {
        ...(defaultCwd ? { cwd: defaultCwd } : {}),
        ...options,
    };
    return _runPixi(pixi, args, spawnOptions, token);
}

export async function listPixiPackages(envName: string, projectPath: string): Promise<PixiPackage[]> {
    const stdout = await runPixi(['list', '--no-install', '--frozen', '--json', '--environment', envName], {
        cwd: projectPath,
    });
    return JSON.parse(stdout);
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

export function pixiPkgsToPackages(pixiPackages: PixiPackage[], environmentId: string): Package[] {
    return pixiPackages.map((pkg) => {
        const tooltip = pkg.kind ? `${pkg.name} ${pkg.version} (${pkg.kind})` : `${pkg.name} ${pkg.version}`;
        return {
            name: pkg.name,
            displayName: pkg.name,
            description: pkg.version,
            version: pkg.version,
            tooltip,
            isTransitive: !pkg.is_explicit,
            pkgId: {
                id: pkg.name,
                managerId: PIXI_MANAGER_ID,
                environmentId,
            },
        } as Package;
    });
}

type PixiPersistentState = {
    [projectPath: string]: string;
};

export async function clearExtensionCache() {
    const state = await getWorkspacePersistentState();
    await state.clear([PIXI_WORKSPACE_KEY, PIXI_GLOBAL_KEY]);
}

export async function getGlobalEnvId(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    return state.get(PIXI_GLOBAL_KEY);
}

export async function setGlobalEnvId(envId: string | undefined) {
    const state = await getWorkspacePersistentState();
    await state.set(PIXI_GLOBAL_KEY, envId);
}

export async function getProjectEnvId(projectPath: string): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const data: PixiPersistentState = (await state.get(PIXI_WORKSPACE_KEY)) ?? {};
    return data[projectPath];
}

export async function setProjectEnvId(projectPath: string, envId: string | undefined) {
    const state = await getWorkspacePersistentState();
    const data: PixiPersistentState = (await state.get(PIXI_WORKSPACE_KEY)) ?? {};
    if (envId) {
        data[projectPath] = envId;
    } else {
        delete data[projectPath];
    }
    await state.set(PIXI_WORKSPACE_KEY, data);
}
