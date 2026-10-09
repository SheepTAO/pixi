import fg from 'fast-glob';
import * as fs from 'fs';
import * as path from 'path';
import { workspace } from 'vscode';

import { untildify } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';

/**
 * Checks if a directory is a Pixi project.
 */
export function isPixiProject(folderPath: string): boolean {
    return fs.existsSync(path.join(folderPath, '.pixi')) || findManifestPath(folderPath) !== undefined;
}

/**
 * Resolves the path to the manifest file ('pixi.toml' or 'pyproject.toml') for a given folder if it exists.
 */
export function findManifestPath(folderPath: string): string | undefined {
    const pixiToml = path.join(folderPath, 'pixi.toml');
    if (fs.existsSync(pixiToml)) {
        return pixiToml;
    }
    const pyprojectToml = path.join(folderPath, 'pyproject.toml');
    if (fs.existsSync(pyprojectToml)) {
        try {
            const content = fs.readFileSync(pyprojectToml, 'utf8');
            if (/(?:^|\n)\s*\[tool\.pixi/.test(content)) {
                return pyprojectToml;
            }
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * Reads configured Conda channels from pixi.toml or pyproject.toml in a project directory.
 */
export function getProjectConfiguredChannels(projectPath: string): string[] {
    const manifestFile = findManifestPath(projectPath);
    if (manifestFile) {
        try {
            const content = fs.readFileSync(manifestFile, 'utf8');
            const match = content.match(/channels\s*=\s*\[([^\]]*)\]/);
            if (match && match[1]) {
                const parsed = match[1]
                    .split(',')
                    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
                    .filter(Boolean);
                if (parsed.length > 0) {
                    return parsed;
                }
            }
        } catch {
            // ignore
        }
    }
    return [];
}

/**
 * Reads search paths and workspace folders, resolves glob patterns,
 * and returns deduplicated pixi project root paths.
 */
export async function resolvePixiProjectPaths(): Promise<string[]> {
    const projectRoots: string[] = [];

    // 1. Direct workspace folders check (covers projects before .pixi is created)
    if (workspace.workspaceFolders) {
        for (const folder of workspace.workspaceFolders) {
            if (isPixiProject(folder.uri.fsPath)) {
                projectRoots.push(folder.uri.fsPath);
            }
        }
    }

    // 2. Glob-based search for nested or external projects
    const workspacePaths = getSearchPaths('workspaceSearchPaths');
    const globalPaths = getSearchPaths('globalSearchPaths');

    const resolvedWorkspace = resolveWorkspacePaths(workspacePaths);
    const resolvedGlobal = globalPaths.map(untildify);
    const allPatterns = [...resolvedWorkspace, ...resolvedGlobal];

    if (allPatterns.length > 0) {
        const pixiDirs = await findPixiDirectories(allPatterns);
        for (const dir of pixiDirs) {
            const root = path.dirname(dir);
            const base = path.basename(dir);
            if (base === '.pixi' || base === 'pixi.toml' || isPixiProject(root)) {
                projectRoots.push(root);
            }
        }
    }

    const uniqueRoots = [...new Set(projectRoots.map(path.normalize))];
    return uniqueRoots.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function getSearchPaths(key: 'workspaceSearchPaths' | 'globalSearchPaths'): string[] {
    try {
        const config = workspace.getConfiguration('pixi');
        const paths = config.get<string[]>(key);
        return paths && paths.length > 0 ? paths : [];
    } catch (error) {
        traceError(`Error reading ${key}:`, error);
        return [];
    }
}

function resolveWorkspacePaths(searchPaths: string[]): string[] {
    const folders = workspace.workspaceFolders;
    const resolved: string[] = [];

    for (const rawPath of searchPaths) {
        const expanded = untildify(rawPath.trim());
        if (!expanded) {
            continue;
        }

        if (path.isAbsolute(expanded)) {
            resolved.push(expanded);
        } else if (folders) {
            for (const folder of folders) {
                resolved.push(path.resolve(folder.uri.fsPath, expanded));
            }
        }
    }

    return resolved;
}

function getSearchIgnorePatterns(): string[] {
    try {
        const config = workspace.getConfiguration('pixi');
        const userPatterns = config.get<string[]>('searchIgnorePatterns');
        if (userPatterns && userPatterns.length > 0) {
            return userPatterns;
        }
    } catch (error) {
        traceError('Error reading pixi.searchIgnorePatterns:', error);
    }
    return ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.venv/**', '**/.pixi/*/**'];
}

async function findPixiDirectories(patterns: string[]): Promise<string[]> {
    const pixiPatterns: string[] = [];

    for (const pattern of patterns) {
        const normalized = pattern.replace(/\\/g, '/').replace(/\/$/, '');
        const lastSegment = path.posix.basename(normalized);

        if (lastSegment === '.pixi' || lastSegment === 'pixi.toml' || lastSegment === 'pyproject.toml') {
            pixiPatterns.push(normalized);
        } else if (lastSegment.startsWith('.')) {
            continue;
        } else {
            pixiPatterns.push(`${normalized}/**/{.pixi,pixi.toml,pyproject.toml}`);
        }
    }

    if (pixiPatterns.length === 0) {
        return [];
    }

    traceVerbose('Searching for .pixi directories or manifests with patterns:', pixiPatterns);

    const ignorePatterns = getSearchIgnorePatterns();

    try {
        const results = await fg(pixiPatterns, {
            onlyDirectories: false,
            absolute: true,
            dot: true,
            followSymbolicLinks: false,
            deep: 10,
            ignore: ignorePatterns,
            suppressErrors: true,
        });

        traceVerbose(`Found ${results.length} .pixi entries or manifests`);
        return results;
    } catch (error) {
        traceError('Error searching for .pixi directories or manifests:', error);
        return [];
    }
}
