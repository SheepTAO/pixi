import * as path from 'path';
import picomatch from 'picomatch';
import { commands, Uri, window, workspace } from 'vscode';

const matcherCache = new Map<string, (input: string) => boolean>();

function getMatcher(pattern: string): (input: string) => boolean {
    const norm = pattern.replace(/\\/g, '/');
    let matcher = matcherCache.get(norm);
    if (!matcher) {
        matcher = picomatch(norm);
        matcherCache.set(norm, matcher);
    }
    return matcher;
}

/**
 * Resolves the target environment name from rules and a relative file path.
 */
export function matchEnvironmentName(rules: string[] | Record<string, string>, relPath: string): string | undefined {
    const normalizedRelPath = relPath.replace(/\\/g, '/');
    const entries = Array.isArray(rules)
        ? rules.map((r) => {
              const sep = r.indexOf('=');
              const i = sep !== -1 ? sep : r.indexOf(':');
              return i !== -1 ? [r.slice(0, i).trim(), r.slice(i + 1).trim()] : ['', ''];
          })
        : Object.entries(rules);

    const baseName = path.posix.basename(normalizedRelPath);
    for (const [pattern, target] of entries) {
        if (pattern && target) {
            const matcher = getMatcher(pattern);
            if (matcher(normalizedRelPath) || matcher(baseName)) {
                return target;
            }
        }
    }
    return undefined;
}

/**
 * Resolves the matching environment for a given document URI according to configured environment rules.
 */
export function matchEnvironmentForUri<T extends { pixiEnvName: string }>(
    uri: Uri,
    projectPath: string,
    envs: T[],
): T | undefined {
    if (uri.scheme === 'file') {
        const relPath = path.relative(projectPath, uri.fsPath).replace(/\\/g, '/');
        if (!relPath.startsWith('..')) {
            const rules = workspace
                .getConfiguration('pixi', uri)
                .get<string[] | Record<string, string>>('environmentRules');
            const target = rules ? matchEnvironmentName(rules, relPath) : undefined;
            if (target) {
                return envs.find((e) => e.pixiEnvName === target);
            }
        }
    }
    return undefined;
}

const STATUS_PRIORITY: Record<string, number> = {
    installed: 0,
    uninstalled: 1,
    incompatible: 2,
};

/**
 * Deterministically sorts Pixi environments: installed first, default first, then alphabetically by envName.
 */
export function sortPixiEnvironments<T extends { pixiEnvName: string; pixiStatus: string }>(envs: T[]): T[] {
    return [...envs].sort((a, b) => {
        const prioA = STATUS_PRIORITY[a.pixiStatus] ?? 99;
        const prioB = STATUS_PRIORITY[b.pixiStatus] ?? 99;
        if (prioA !== prioB) {
            return prioA - prioB;
        }
        if (a.pixiEnvName === b.pixiEnvName) {
            return 0;
        }
        if (a.pixiEnvName === 'default') {
            return -1;
        }
        if (b.pixiEnvName === 'default') {
            return 1;
        }
        return a.pixiEnvName.localeCompare(b.pixiEnvName, undefined, { sensitivity: 'base' });
    });
}

/**
 * Picks the most appropriate default environment from a list:
 * Installed 'default' > any installed > uninstalled 'default' > first environment.
 */
export function getDefaultEnvironment<T extends { pixiEnvName: string; pixiStatus: string }>(envs: T[]): T | undefined {
    return (
        envs.find((e) => e.pixiEnvName === 'default' && e.pixiStatus === 'installed') ||
        envs.find((e) => e.pixiStatus === 'installed') ||
        envs.find((e) => e.pixiEnvName === 'default') ||
        envs[0]
    );
}

/**
 * Returns the status icon and human-readable badge text for environment QuickPick displays.
 */
export function getEnvironmentStatusBadge(status?: string): { icon: string; text: string } {
    if (status === 'uninstalled') {
        return { icon: '$(cloud-download)', text: '(not installed)' };
    }
    if (status === 'incompatible') {
        return { icon: '$(circle-slash)', text: '(incompatible)' };
    }
    return { icon: '$(layers)', text: '' };
}

/**
 * Minimal interface representing an environment with status information.
 */
export interface EnvironmentLike {
    pixiEnvName: string;
    projectPath: string;
    pixiStatus: string;
    statusReason?: string;
}

export interface EnsureEnvironmentOptions {
    /** The action name/description to display in error messages, e.g. "open terminal for environment" */
    action?: string;
    /** The target environment name to display in messages (defaults to env.pixiEnvName) */
    targetName?: string;
    /** Custom installation prompt message for uninstalled environments */
    customInstallPrompt?: string;
    /** Custom project path or Uri (defaults to env.projectPath) */
    projectPath?: string | Uri;
}

/**
 * Prompts the user to install an uninstalled Pixi environment and executes 'pixi.install'.
 */
export async function promptToInstallEnvironment(
    envName: string,
    projectPath: string | Uri,
    message?: string,
): Promise<boolean> {
    const prompt =
        message || `Environment '${envName}' is not installed yet on disk. Would you like to install it now?`;
    const action = await window.showWarningMessage(prompt, 'Install Environment');
    if (action === 'Install Environment') {
        const folder = typeof projectPath === 'string' ? Uri.file(projectPath) : projectPath;
        void commands.executeCommand('pixi.install', folder, envName);
        return true;
    }
    return false;
}

/**
 * Unified environment readiness guard for the entire extension:
 * - If the environment is 'installed', returns true.
 * - If the environment is 'incompatible', displays a standardized error message and returns false.
 * - If the environment is 'uninstalled', prompts the user to install it and returns false.
 */
export async function ensureEnvironmentReady(
    env: EnvironmentLike | undefined,
    options?: EnsureEnvironmentOptions,
): Promise<boolean> {
    if (!env) {
        return false;
    }

    if (env.pixiStatus === 'installed') {
        return true;
    }

    const name = options?.targetName || env.pixiEnvName;

    if (env.pixiStatus === 'incompatible') {
        const actionPrefix = options?.action ? `Cannot ${options.action}` : 'Cannot use environment';
        const reason = env.statusReason || 'The environment is incompatible with the current platform.';
        void window.showErrorMessage(`${actionPrefix} '${name}': ${reason}`);
        return false;
    }

    if (env.pixiStatus === 'uninstalled') {
        const prompt =
            options?.customInstallPrompt ||
            `Environment '${name}' is not installed yet on disk. Would you like to install it now?`;
        await promptToInstallEnvironment(env.pixiEnvName, options?.projectPath ?? env.projectPath, prompt);
        return false;
    }

    return false;
}
