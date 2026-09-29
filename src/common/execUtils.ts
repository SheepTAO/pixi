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

/**
 * Safely parses JSON from CLI output that may contain extraneous leading/trailing logs or warnings.
 * Automatically slices between the outermost JSON brackets ({...} or [...]).
 */
export function safeJsonParse<T>(text: string, fallback?: T): T {
    const trimmed = text.trim();
    const firstBrace = trimmed.indexOf('{');
    const firstBracket = trimmed.indexOf('[');

    let start = -1;
    let end = -1;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        start = firstBrace;
        end = trimmed.lastIndexOf('}');
    } else if (firstBracket !== -1) {
        start = firstBracket;
        end = trimmed.lastIndexOf(']');
    }

    if (start !== -1 && end !== -1 && end > start) {
        try {
            return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
            // Fall through to parse trimmed
        }
    }

    try {
        return JSON.parse(trimmed);
    } catch (e) {
        if (fallback !== undefined) {
            return fallback;
        }
        throw e;
    }
}

/**
 * Resolves a directory path from various command arguments (Uri, string path, or tree item objects).
 */
export function normalizeFolderPath(target?: unknown): string | undefined {
    if (!target) {
        return undefined;
    }
    const safeDir = (p: string): string => {
        try {
            if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
                return path.dirname(p);
            }
        } catch {
            // ignore stat failure
        }
        return p;
    };
    const candidate =
        typeof target === 'string'
            ? target
            : (target as any)?.projectPath ||
              (target as any)?.project?.projectPath ||
              (target as any)?.env?.projectPath ||
              (target as any)?.fsPath;
    return typeof candidate === 'string' ? safeDir(candidate) : undefined;
}

/**
 * Escapes characters with special meaning in regular expressions.
 */
export function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
