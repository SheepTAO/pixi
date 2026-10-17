import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    CancellationError,
    CancellationToken,
    Position,
    ProgressLocation,
    Range,
    Selection,
    TextEditor,
    TextEditorRevealType,
    Uri,
    window,
    workspace,
} from 'vscode';

const SINGLE_OPERATOR_REGEX = /^[&|<>;()[\]{}]$/;
const SHELL_SPECIAL_CHARS_REGEX = /[\s&|<>;'"`()\[\]{}$]/;

export function quoteStringIfNecessary(arg: string): string {
    // Always return if already quoted to avoid double-quoting
    if (arg.startsWith('"') && arg.endsWith('"')) {
        return arg;
    }

    // Don't quote single shell operators/special characters
    if (SINGLE_OPERATOR_REGEX.test(arg)) {
        return arg;
    }

    // Quote if contains common shell special characters that are problematic across multiple shells
    // Includes: space, &, |, <, >, ;, ', ", `, (, ), [, ], {, }, $
    return SHELL_SPECIAL_CHARS_REGEX.test(arg) ? `"${arg}"` : arg;
}

export function quoteArgs(args: string[]): string[] {
    return args.map(quoteStringIfNecessary);
}

/**
 * Strips surrounding single or double quotes from a string, if present.
 */
export function unquoteString(val: string): string {
    const trimmed = val.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

export interface ExecutableCandidates {
    posix: string[];
    win32: string[];
}

/**
 * Searches for an executable within a directory based on platform-specific candidate relative paths.
 * Returns the absolute path to the first matching executable, or undefined if none are found.
 */
export function findExecutable(baseDir: string, candidates: ExecutableCandidates): string | undefined {
    const list = process.platform === 'win32' ? candidates.win32 : candidates.posix;
    for (const rel of list) {
        const fullPath = path.join(baseDir, rel);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }
    return undefined;
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

    let jsonSlice = trimmed;
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        const end = trimmed.lastIndexOf('}');
        if (end > firstBrace) {
            jsonSlice = trimmed.slice(firstBrace, end + 1);
        }
    } else if (firstBracket !== -1) {
        const end = trimmed.lastIndexOf(']');
        if (end > firstBracket) {
            jsonSlice = trimmed.slice(firstBracket, end + 1);
        }
    }

    try {
        return JSON.parse(jsonSlice);
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
interface PathContextCandidate {
    projectPath?: string;
    project?: { projectPath?: string };
    fsPath?: string;
}

/**
 * Resolves a file or directory path from various command arguments (Uri, string path, or tree item objects).
 */
export function normalizeLocationPath(target?: unknown): string | undefined {
    if (!target) {
        return undefined;
    }
    if (typeof target === 'string') {
        return target;
    }
    if (target instanceof Uri) {
        return target.fsPath;
    }
    if (typeof target === 'object') {
        const t = target as PathContextCandidate;
        return t.projectPath || t.project?.projectPath || t.fsPath;
    }
    return undefined;
}

/**
 * Resolves a directory path from various command arguments, ensuring file paths are resolved to their parent directory.
 */
export function normalizeFolderPath(target?: unknown): string | undefined {
    const p = normalizeLocationPath(target);
    if (!p) {
        return undefined;
    }
    try {
        if (!fs.statSync(p).isDirectory()) {
            return path.dirname(p);
        }
    } catch {
        // ignore stat failure
    }
    return p;
}

/**
 * Generates a normalized project key for map caching, taking into account OS path casing.
 */
export function getProjectKey(projectPath: string): string {
    const normalized = path.normalize(projectPath).replace(/[/\\]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Escapes characters with special meaning in regular expressions.
 */
export function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Encodes a command argument for use in VS Code markdown command URIs (`command:...?...`).
 */
export function encodeCommandArg(arg: unknown): string {
    return encodeURIComponent(JSON.stringify([arg]));
}

/**
 * Reveals and highlights the specified line and column range in an active text editor.
 */
export function revealRangeInEditor(editor: TextEditor, line: number, startCol: number, endCol: number): void {
    const startPos = new Position(line, startCol);
    const endPos = new Position(line, endCol);
    editor.selection = new Selection(startPos, endPos);
    editor.revealRange(new Range(startPos, endPos), TextEditorRevealType.InCenter);
}

export interface RevealDefinitionOptions {
    manifestPath?: string;
    targetName: string;
    kind: 'package' | 'task' | 'feature' | 'platforms';
}

/**
 * Locates and highlights a package dependency, task definition, or feature section line in a project manifest file (pixi.toml or pyproject.toml).
 */
export async function revealDefinitionInManifest(options: RevealDefinitionOptions): Promise<boolean> {
    const { manifestPath, targetName, kind } = options;
    if (!manifestPath || !fs.existsSync(manifestPath)) {
        window.showWarningMessage('Could not find manifest file for this project.');
        return false;
    }

    try {
        const doc = await workspace.openTextDocument(Uri.file(manifestPath));
        const editor = await window.showTextDocument(doc);
        const text = doc.getText();
        const lines = text.split(/\r?\n/);

        const escapedName = escapeRegex(targetName);
        const namePattern = kind === 'package' ? escapedName.replace(/[-_]/g, '[-_]') : escapedName;

        const keyRegex = new RegExp(`^\\s*["']?${namePattern}["']?\\s*=`, 'i');
        const taskSectionRegex = new RegExp(`^\\s*\\[+.*tasks\\.(["']?)${escapedName}\\1\\]`, 'i');
        const featureSectionRegex = new RegExp(`^\\s*\\[+.*features?\\.(["']?)${escapedName}\\1`, 'i');
        const pyprojectDepRegex = new RegExp(`["']${namePattern}(?:\\s*[\\[><=~!^;@]|["'])`, 'i');

        let targetLine = -1;
        let fallbackLine = -1;
        let currentSection = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const sectionMatch = line.match(/^\s*\[+([^\]]+)\]+/);
            if (sectionMatch) {
                currentSection = sectionMatch[1].trim();
            }

            if (kind === 'platforms') {
                const platformsRegex = /^\s*\[+(?:tool\.pixi\.)?(?:workspace\.)?platforms\]+/i;
                const platformsKeyRegex = /^\s*platforms\s*=/i;
                if (targetName === 'platforms') {
                    if (platformsRegex.test(line) || platformsKeyRegex.test(line)) {
                        targetLine = i;
                        break;
                    }
                } else {
                    if (keyRegex.test(line) || line.includes(targetName)) {
                        targetLine = i;
                        break;
                    } else if ((platformsRegex.test(line) || platformsKeyRegex.test(line)) && fallbackLine < 0) {
                        fallbackLine = i;
                    }
                }
            } else if (kind === 'task') {
                if (taskSectionRegex.test(line)) {
                    targetLine = i;
                    break;
                }
                const isTasksSection = /(^|\.)tasks(\.|$)/i.test(currentSection);
                if (keyRegex.test(line)) {
                    if (isTasksSection) {
                        targetLine = i;
                        break;
                    } else if (fallbackLine < 0) {
                        fallbackLine = i;
                    }
                }
            } else if (kind === 'feature') {
                if (targetName === 'default') {
                    const defaultSectionRegex =
                        /^\s*\[+(?:tool\.pixi\.)?(?:dependencies|pypi-dependencies|workspace)\]/i;
                    if (defaultSectionRegex.test(line)) {
                        targetLine = i;
                        break;
                    }
                } else {
                    if (featureSectionRegex.test(line)) {
                        targetLine = i;
                        break;
                    }
                    const isFeatureSection = /(^|\.)features?(\.|$)/i.test(currentSection);
                    if (keyRegex.test(line)) {
                        if (isFeatureSection) {
                            targetLine = i;
                            break;
                        } else if (fallbackLine < 0) {
                            fallbackLine = i;
                        }
                    }
                }
            } else {
                const isDepSection =
                    /(^|\.)(?:dependencies|pypi-dependencies|build-dependencies|host-dependencies|optional-dependencies)(\.|$)/i.test(
                        currentSection,
                    );
                if (keyRegex.test(line) || pyprojectDepRegex.test(line)) {
                    if (isDepSection) {
                        targetLine = i;
                        break;
                    } else if (fallbackLine < 0) {
                        fallbackLine = i;
                    }
                }
            }
        }

        const finalLine = targetLine >= 0 ? targetLine : fallbackLine;
        if (finalLine >= 0) {
            const lineText = lines[finalLine];
            const nameRegex = new RegExp(`(?:\\b|["'])(${namePattern})(?:\\b|["'])`, 'i');
            const match = nameRegex.exec(lineText);
            let startCol = 0;
            let endCol = lineText.length;
            if (match && match.index !== undefined) {
                const innerIdx = match[0].indexOf(match[1]);
                startCol = match.index + (innerIdx >= 0 ? innerIdx : 0);
                endCol = startCol + match[1].length;
            }
            revealRangeInEditor(editor, finalLine, startCol, endCol);
            return true;
        }

        const label = kind === 'task' ? `task definition for '${targetName}'` : `definition for '${targetName}'`;
        window.showInformationMessage(`Could not locate ${label} in ${path.basename(manifestPath)}.`);
        return false;
    } catch (err: unknown) {
        window.showErrorMessage(`Failed to open manifest: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

export interface ProgressNotificationOptions {
    errorPrefix?: string;
    cancellable?: boolean;
}

/**
 * Executes an async action inside a VS Code notification progress indicator,
 * showing a success message on completion or an error message on failure.
 */
export async function runWithProgressNotification<T>(
    title: string,
    action: (token: CancellationToken) => Promise<T>,
    successMsg?: string | ((result: T) => string),
    options?: ProgressNotificationOptions,
): Promise<boolean> {
    const opts: ProgressNotificationOptions = options ?? {};
    try {
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title,
                cancellable: opts.cancellable ?? true,
            },
            async (_progress, token) => {
                const result = await action(token);
                if (successMsg && !token.isCancellationRequested) {
                    const finalMsg = typeof successMsg === 'function' ? successMsg(result) : successMsg;
                    if (finalMsg) {
                        window.showInformationMessage(finalMsg);
                    }
                }
            },
        );
        return true;
    } catch (error) {
        if (error instanceof CancellationError) {
            return false;
        }
        const msg = error instanceof Error ? error.message : String(error);
        window.showErrorMessage(opts.errorPrefix ? `${opts.errorPrefix}: ${msg}` : msg);
        return false;
    }
}

const SENSITIVE_ARG_FLAGS = new Set([
    '--token',
    '--password',
    '--conda-token',
    '--s3-secret-access-key',
    '--s3-session-token',
    '--oauth-client-secret',
]);

/**
 * Redacts sensitive credentials (tokens, passwords, secret keys) from command-line arguments for logging.
 */
export function sanitizeArgsForLogging(args: string[]): string[] {
    const sanitized: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (SENSITIVE_ARG_FLAGS.has(arg)) {
            sanitized.push(arg);
            if (i + 1 < args.length) {
                sanitized.push('***');
                i++;
            }
        } else {
            let replaced = false;
            for (const flag of SENSITIVE_ARG_FLAGS) {
                if (arg.startsWith(`${flag}=`)) {
                    sanitized.push(`${flag}=***`);
                    replaced = true;
                    break;
                }
            }
            if (!replaced) {
                sanitized.push(arg);
            }
        }
    }
    return sanitized;
}
