import * as path from 'path';
import picomatch from 'picomatch';

const matcherCache = new Map<string, (input: string) => boolean>();

function getMatcher(pattern: string): (input: string) => boolean {
    let matcher = matcherCache.get(pattern);
    if (!matcher) {
        matcher = picomatch(pattern);
        matcherCache.set(pattern, matcher);
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
    const entries = Array.isArray(rules)
        ? rules.map((r) => {
              const i = r.indexOf('=') !== -1 ? r.indexOf('=') : r.indexOf(':');
              return i !== -1 ? [r.slice(0, i).trim(), r.slice(i + 1).trim()] : ['', ''];
          })
        : Object.entries(rules);

    const baseName = path.posix.basename(relPath);
    for (const [pattern, target] of entries) {
        if (pattern && target) {
            const matcher = getMatcher(pattern);
            if (matcher(relPath) || matcher(baseName)) {
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
