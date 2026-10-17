import * as os from 'os';
import * as path from 'path';
import { CancellationToken, EventEmitter } from 'vscode';

import { safeJsonParse } from '../common/execUtils';
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

export function getToolVersion(tool: PixiGlobalEnvironment): string {
    const v = tool.dependencies?.[0]?.version;
    return v ? `v${v}` : '';
}

export function extractToolName(target?: unknown): string | undefined {
    if (!target) {
        return undefined;
    }
    if (typeof target === 'string') {
        return target;
    }
    if (typeof target === 'object') {
        const item = target as { name?: string; tool?: { name?: string } };
        return item.tool?.name || item.name;
    }
    return undefined;
}

const _onDidChangeGlobalEnvironments = new EventEmitter<void>();
export const onDidChangeGlobalEnvironments = _onDidChangeGlobalEnvironments.event;

export function refreshGlobalEnvironments(): void {
    _onDidChangeGlobalEnvironments.fire();
}

export async function getGlobalManifestPath(): Promise<string> {
    try {
        const stdout = await runPixi(['info', '--json']);
        const info = safeJsonParse<{ global_info?: { manifest?: string } }>(stdout, {});
        const manifest = info.global_info?.manifest;
        if (typeof manifest === 'string' && manifest.trim()) {
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
        const parsed = safeJsonParse<PixiGlobalEnvironment[]>(stdout, []);
        if (Array.isArray(parsed)) {
            return parsed.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
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
    refreshGlobalEnvironments();
    return output;
}

export async function updateGlobalTool(toolName?: string, token?: CancellationToken): Promise<string> {
    const args = ['global', 'update'];
    if (toolName) {
        args.push(toolName);
    }
    const output = await runPixi(args, undefined, token);
    refreshGlobalEnvironments();
    return output;
}

export async function uninstallGlobalTool(toolName: string, token?: CancellationToken): Promise<string> {
    const args = ['global', 'uninstall', toolName];
    const output = await runPixi(args, undefined, token);
    refreshGlobalEnvironments();
    return output;
}

export async function syncGlobalEnvironments(token?: CancellationToken): Promise<string> {
    const args = ['global', 'sync'];
    const output = await runPixi(args, undefined, token);
    refreshGlobalEnvironments();
    return output;
}

export async function addGlobalDependency(
    toolName: string,
    packages: string[],
    token?: CancellationToken,
): Promise<string> {
    const args = ['global', 'add', '-e', toolName, ...packages];
    const output = await runPixi(args, undefined, token);
    refreshGlobalEnvironments();
    return output;
}

export async function removeGlobalDependency(
    toolName: string,
    packages: string[],
    token?: CancellationToken,
): Promise<string> {
    const args = ['global', 'remove', '-e', toolName, ...packages];
    const output = await runPixi(args, undefined, token);
    refreshGlobalEnvironments();
    return output;
}

export async function exposeGlobalBinary(
    toolName: string,
    mapping: string,
    token?: CancellationToken,
): Promise<string> {
    const args = ['global', 'expose', 'add', mapping, '-e', toolName];
    const output = await runPixi(args, undefined, token);
    refreshGlobalEnvironments();
    return output;
}

export async function unexposeGlobalBinary(exposedNames: string[], token?: CancellationToken): Promise<string> {
    const args = ['global', 'expose', 'remove', ...exposedNames];
    const output = await runPixi(args, undefined, token);
    refreshGlobalEnvironments();
    return output;
}
