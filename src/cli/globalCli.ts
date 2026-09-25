import * as os from 'os';
import * as path from 'path';
import { CancellationToken, EventEmitter } from 'vscode';

import { traceError } from '../common/logging';
import { runPixi } from './pixiCli';

export interface PixiGlobalDependency {
    name: string;
    version: string;
}

export interface PixiGlobalExposed {
    exposed_name: string;
    executable: string;
}

export interface PixiGlobalEnvironment {
    name: string;
    dependencies?: PixiGlobalDependency[];
    exposed?: PixiGlobalExposed[];
}

const _onDidChangeGlobalEnvironments = new EventEmitter<void>();
export const onDidChangeGlobalEnvironments = _onDidChangeGlobalEnvironments.event;

export function fireGlobalEnvironmentsChanged(): void {
    _onDidChangeGlobalEnvironments.fire();
}

let _cachedGlobalManifestPath: string | undefined;

export function clearGlobalManifestCache(): void {
    _cachedGlobalManifestPath = undefined;
}

export async function getGlobalManifestPath(): Promise<string> {
    if (_cachedGlobalManifestPath) {
        return _cachedGlobalManifestPath;
    }
    try {
        const stdout = await runPixi(['info', '--json']);
        const info = JSON.parse(stdout);
        const manifest = info.global_info?.manifest;
        if (typeof manifest === 'string' && manifest.trim()) {
            _cachedGlobalManifestPath = manifest;
            return manifest;
        }
    } catch {
        // Fallback to default path if pixi info fails
    }
    const pixiHome = process.env.PIXI_HOME || path.join(os.homedir(), '.pixi');
    return path.join(pixiHome, 'manifests', 'pixi-global.toml');
}

export async function listGlobalEnvironments(): Promise<PixiGlobalEnvironment[] | undefined> {
    try {
        const stdout = await runPixi(['global', 'list', '--json']);
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed)) {
            return parsed as PixiGlobalEnvironment[];
        }
        return [];
    } catch (error) {
        traceError('Failed to list pixi global environments:', error);
        return undefined;
    }
}

export async function installGlobalTools(
    tools: string[],
    channel?: string,
    token?: CancellationToken,
): Promise<string> {
    const args = ['global', 'install'];
    if (channel) {
        args.push('-c', channel);
    }
    args.push(...tools);
    const output = await runPixi(args, undefined, token);
    _onDidChangeGlobalEnvironments.fire();
    return output;
}

export async function updateGlobalTool(toolName?: string, token?: CancellationToken): Promise<string> {
    const args = ['global', 'update'];
    if (toolName) {
        args.push(toolName);
    }
    const output = await runPixi(args, undefined, token);
    _onDidChangeGlobalEnvironments.fire();
    return output;
}

export async function uninstallGlobalTool(toolName: string, token?: CancellationToken): Promise<string> {
    const args = ['global', 'uninstall', toolName];
    const output = await runPixi(args, undefined, token);
    _onDidChangeGlobalEnvironments.fire();
    return output;
}

export async function syncGlobalEnvironments(token?: CancellationToken): Promise<string> {
    const args = ['global', 'sync'];
    const output = await runPixi(args, undefined, token);
    _onDidChangeGlobalEnvironments.fire();
    return output;
}
