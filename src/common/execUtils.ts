import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Position, Range, Selection, TextEditor, TextEditorRevealType, Uri, window, workspace } from 'vscode';

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
    if (!text || typeof text !== 'string') {
        return fallback as T;
    }
    const trimmed = text.trim();
    if (!trimmed) {
        return fallback as T;
    }
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
interface PathContextCandidate {
    projectPath?: string;
    project?: { projectPath?: string };
    env?: { projectPath?: string };
    task?: { projectPath?: string };
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
    const t = target as PathContextCandidate;
    return t.projectPath || t.project?.projectPath || t.env?.projectPath || t.task?.projectPath || t.fsPath;
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
        if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
            return path.dirname(p);
        }
    } catch {
        // ignore stat failure
    }
    return p;
}

/**
 * Escapes characters with special meaning in regular expressions.
 */
export function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    manifestPath: string;
    targetName: string;
    kind: 'package' | 'task';
}

/**
 * Locates and highlights a package dependency or task definition line in a project manifest file (pixi.toml or pyproject.toml).
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
        const altName =
            kind === 'package'
                ? targetName.includes('-')
                    ? targetName.replace(/-/g, '_')
                    : targetName.includes('_')
                      ? targetName.replace(/_/g, '-')
                      : undefined
                : undefined;
        const namePattern = altName ? `(?:${escapedName}|${escapeRegex(altName)})` : escapedName;

        const keyRegex = new RegExp(`^\\s*["']?${namePattern}["']?\\s*=`, 'i');
        const taskSectionRegex =
            kind === 'task' ? new RegExp(`^\\s*\\[+.*tasks\\.(["']?)${escapedName}\\1\\]`, 'i') : undefined;
        const pyprojectDepRegex =
            kind === 'package' ? new RegExp(`["']${namePattern}(?:\\s*[\\[><=~!^;@]|["'])`, 'i') : undefined;

        let targetLine = -1;
        let fallbackLine = -1;
        let currentSection = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const sectionMatch = line.match(/^\s*\[+([^\]]+)\]+/);
            if (sectionMatch) {
                currentSection = sectionMatch[1].trim();
            }

            if (kind === 'task') {
                if (taskSectionRegex && taskSectionRegex.test(line)) {
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
            } else {
                const isDepSection =
                    /(^|\.)(?:dependencies|pypi-dependencies|build-dependencies|host-dependencies|optional-dependencies)(\.|$)/i.test(
                        currentSection,
                    );
                const isMatch = keyRegex.test(line) || (pyprojectDepRegex ? pyprojectDepRegex.test(line) : false);
                if (isMatch) {
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

/**
 * Updates a TreeView description to show the single project name and manifest if only one project exists.
 */
export function updateProjectTreeViewDescription(
    treeView: { description?: string } | undefined,
    projectManager: { getProjects: () => Array<{ name: string; manifestPath: string }> },
): void {
    if (!treeView) {
        return;
    }
    const projects = projectManager.getProjects();
    treeView.description =
        projects.length === 1 ? `${projects[0].name} (${path.basename(projects[0].manifestPath)})` : undefined;
}
