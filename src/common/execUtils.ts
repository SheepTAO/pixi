import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Position, Range, Selection, TextEditor, TextEditorRevealType, Uri, window, workspace } from 'vscode';

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
    fsPath?: string;
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
    if (typeof target === 'string') {
        return safeDir(target);
    }
    const t = target as PathContextCandidate;
    const candidate = t.projectPath || t.project?.projectPath || t.env?.projectPath || t.fsPath;
    return typeof candidate === 'string' ? safeDir(candidate) : undefined;
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
        let targetLine = -1;
        let startCol = 0;
        let endCol = 0;

        if (kind === 'task') {
            const keyRegex = new RegExp(`^\\s*["']?${escapedName}["']?\\s*=`, 'i');
            const sectionRegex = new RegExp(`^\\s*\\[+.*tasks\\.(["']?)${escapedName}\\1\\]`, 'i');
            let currentSection = '';
            let matchedViaSection = false;

            // Pass 1: search inside recognized tasks section
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const sectionMatch = line.match(/^\s*\[+([^\]]+)\]+/);
                if (sectionMatch) {
                    currentSection = sectionMatch[1].trim();
                }
                if (sectionRegex.test(line)) {
                    targetLine = i;
                    matchedViaSection = true;
                    break;
                }
                const isTasksSection = /(^|\.)tasks(\.|$)/i.test(currentSection);
                if (isTasksSection && keyRegex.test(line)) {
                    targetLine = i;
                    break;
                }
            }

            // Fallback pass: search across entire file
            if (targetLine < 0) {
                for (let i = 0; i < lines.length; i++) {
                    if (keyRegex.test(lines[i])) {
                        targetLine = i;
                        break;
                    }
                }
            }

            if (targetLine >= 0) {
                const lineText = lines[targetLine];
                const baseOffset = matchedViaSection ? Math.max(0, lineText.toLowerCase().lastIndexOf('tasks.')) : 0;
                const searchPart = matchedViaSection
                    ? lineText.slice(baseOffset)
                    : lineText.indexOf('=') >= 0
                      ? lineText.slice(0, lineText.indexOf('='))
                      : lineText;

                const m = searchPart.match(new RegExp(`(["']?)(${escapedName})\\1`, 'i'));
                if (m && m.index !== undefined) {
                    const quoteOffset = m[1] ? m[1].length : 0;
                    startCol = baseOffset + m.index + quoteOffset;
                    endCol = startCol + targetName.length;
                } else {
                    endCol = lineText.length;
                }
                revealRangeInEditor(editor, targetLine, startCol, endCol);
                return true;
            } else {
                window.showInformationMessage(
                    `Could not locate task definition for '${targetName}' in ${path.basename(manifestPath)}.`,
                );
                return false;
            }
        } else {
            const altName = targetName.includes('-')
                ? targetName.replace(/-/g, '_')
                : targetName.includes('_')
                  ? targetName.replace(/_/g, '-')
                  : undefined;
            const escapedAlt = altName ? escapeRegex(altName) : undefined;
            const namePattern = escapedAlt ? `(?:${escapedName}|${escapedAlt})` : escapedName;

            const exactKeyRegex = new RegExp(`^\\s*["']?${namePattern}["']?\\s*=`, 'i');
            const pyprojectDepRegex = new RegExp(`["']${namePattern}(?:\\s*[\\[><=~!^;@]|["'])`, 'i');

            let currentSection = '';
            // Pass 1: search inside recognized dependency tables
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const sectionMatch = line.match(/^\s*\[+([^\]]+)\]+/);
                if (sectionMatch) {
                    currentSection = sectionMatch[1].trim();
                }

                const isDepSection =
                    /(^|\.)(?:dependencies|pypi-dependencies|build-dependencies|host-dependencies|optional-dependencies)(\.|$)/i.test(
                        currentSection,
                    );
                if (isDepSection && (exactKeyRegex.test(line) || pyprojectDepRegex.test(line))) {
                    targetLine = i;
                    break;
                }
            }

            // Pass 2: fallback search across entire file
            if (targetLine < 0) {
                for (let i = 0; i < lines.length; i++) {
                    if (exactKeyRegex.test(lines[i]) || pyprojectDepRegex.test(lines[i])) {
                        targetLine = i;
                        break;
                    }
                }
            }

            if (targetLine >= 0) {
                const lineText = lines[targetLine];
                const nameRegex = new RegExp(`(?:\\b|["'])(${namePattern})(?:\\b|["'])`, 'i');
                const match = nameRegex.exec(lineText);
                startCol = 0;
                endCol = lineText.length;
                if (match && match.index !== undefined) {
                    const innerIdx = match[0].indexOf(match[1]);
                    startCol = match.index + (innerIdx >= 0 ? innerIdx : 0);
                    endCol = startCol + match[1].length;
                }
                revealRangeInEditor(editor, targetLine, startCol, endCol);
                return true;
            } else {
                window.showInformationMessage(
                    `Could not locate definition for '${targetName}' in ${path.basename(manifestPath)}.`,
                );
                return false;
            }
        }
    } catch (err: unknown) {
        window.showErrorMessage(`Failed to open manifest: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
