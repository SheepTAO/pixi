import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function quoteStringIfNecessary(arg: string): string {
    // Always return if already quoted to avoid double-quoting
    if (arg.startsWith('"') && arg.endsWith('"')) {
        return arg;
    }

    // Don't quote single shell operators/special characters
    if (arg.length === 1 && /[&|<>;()[\]{}$]/.test(arg)) {
        return arg;
    }

    // Quote if contains common shell special characters that are problematic across multiple shells
    // Includes: space, &, |, <, >, ;, ', ", `, (, ), [, ], {, }, $
    const needsQuoting = /[\s&|<>;'"`()\[\]{}$]/.test(arg);

    return needsQuoting ? `"${arg}"` : arg;
}

export function quoteArgs(args: string[]): string[] {
    return args.map(quoteStringIfNecessary);
}

export interface ExecutableCandidates {
    posix: string[];
    win32: string[];
}

/**
 * Searches for an executable within a directory based on platform-specific candidate relative paths.
 * Returns the absolute path to the first matching executable, or null if none are found.
 */
export async function findExecutable(baseDir: string, candidates: ExecutableCandidates): Promise<string | null> {
    const list = os.platform() === 'win32' ? candidates.win32 : candidates.posix;
    for (const rel of list) {
        const fullPath = path.join(baseDir, rel);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }
    return null;
}

/**
 * Expands home directory tilde (~) prefix in a path to the user's home directory.
 */
export function untildify(p: string): string {
    return p.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);
}
