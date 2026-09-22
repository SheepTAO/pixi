import picomatch from 'picomatch';

import { PixiEnvironment } from './types';

export function matchEnvironmentRule(
    rules: string[] | Record<string, string>,
    relPath: string,
    envs: PixiEnvironment[],
): PixiEnvironment | undefined {
    const entries = Array.isArray(rules)
        ? rules.map((r) => {
              const i = r.indexOf('=') !== -1 ? r.indexOf('=') : r.indexOf(':');
              return i !== -1 ? [r.slice(0, i).trim(), r.slice(i + 1).trim()] : ['', ''];
          })
        : Object.entries(rules);

    for (const [pattern, target] of entries) {
        if (pattern && target && picomatch.isMatch(relPath, pattern)) {
            const matched =
                envs.find((e) => e.pixiEnvName === target) ||
                envs.find((e) => e.displayName.startsWith(`${target} `) || e.name === target);
            if (matched) {
                return matched;
            }
        }
    }
    return undefined;
}
