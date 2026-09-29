import * as path from 'path';
import picomatch from 'picomatch';

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

export function clearMatcherCache(): void {
    matcherCache.clear();
}

/**
 * Resolves the target environment name from rules and a relative file path.
 */
export function matchEnvironmentName(rules: string[] | Record<string, string>, relPath: string): string | undefined {
    const normalizedRelPath = relPath.replace(/\\/g, '/');
    const entries = Array.isArray(rules)
        ? rules.map((r) => {
              const i = r.indexOf('=') !== -1 ? r.indexOf('=') : r.indexOf(':');
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
 * Generic environment matcher that finds the matching environment object from a list.
 */
export function matchEnvironmentRule<T extends { pixiEnvName: string; displayName?: string; name?: string }>(
    rules: string[] | Record<string, string>,
    relPath: string,
    envs: T[],
): T | undefined {
    const target = matchEnvironmentName(rules, relPath);
    if (!target) {
        return undefined;
    }
    return (
        envs.find((e) => e.pixiEnvName === target) ||
        envs.find((e) => (e.displayName && e.displayName.startsWith(`${target} `)) || e.name === target)
    );
}

/**
 * Deterministically sorts Pixi environments: installed first, default first, then alphabetically by envName.
 */
export function sortPixiEnvironments<T extends { pixiEnvName: string; pixiStatus: string }>(envs: T[]): T[] {
    const statusPriority: Record<string, number> = {
        installed: 0,
        uninstalled: 1,
        incompatible: 2,
    };

    return [...envs].sort((a, b) => {
        const prioA = statusPriority[a.pixiStatus] ?? 99;
        const prioB = statusPriority[b.pixiStatus] ?? 99;
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
export function getDefaultEnvironment<T extends { pixiEnvName: string; pixiStatus: string }>(
    envs: T[],
): T | undefined {
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
