import * as ch from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CancellationError, CancellationToken, workspace } from 'vscode';
import which from 'which';

import { createDeferred } from '../common/deferred';
import { quoteArgs } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';
import { untildify } from '../common/utils';

let _cachedPixi: string | undefined;

export function clearPixiCache(): void {
    _cachedPixi = undefined;
}

async function findPixi(): Promise<string | undefined> {
    try {
        return await which('pixi');
    } catch {
        return undefined;
    }
}

export async function getPixi(): Promise<string> {
    if (_cachedPixi) {
        return _cachedPixi;
    }

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
        _cachedPixi = resolved;
        return resolved;
    }

    const pixiPath = await findPixi();
    if (!pixiPath) {
        throw new Error(
            'Pixi executable not found. Please install Pixi or set "pixi-python.pixiExecutable" in your settings.',
        );
    }
    _cachedPixi = pixiPath;
    return pixiPath;
}

export async function _runPixi(
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
        traceVerbose(`[pixi stderr] ${d.trim()}`);
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
            traceError(`Failed to run "pixi ${args.join(' ')}":\n${stderr}`);
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
