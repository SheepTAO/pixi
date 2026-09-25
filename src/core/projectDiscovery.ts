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
    if (fs.existsSync(path.join(folderPath, 'pixi.toml')) || fs.existsSync(path.join(folderPath, '.pixi'))) {
        return true;
    }
    const pyprojectPath = path.join(folderPath, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
        try {
            const content = fs.readFileSync(pyprojectPath, 'utf8');
            return /(?:^|\n)\s*\[tool\.pixi/.test(content);
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * Reads configured Conda channels from pixi.toml or pyproject.toml in a project directory.
 */
export function getProjectConfiguredChannels(projectPath: string): string[] {
    for (const manifestName of ['pixi.toml', 'pyproject.toml']) {
        const manifestFile = path.join(projectPath, manifestName);
        if (fs.existsSync(manifestFile)) {
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
    const workspacePaths = getWorkspaceSearchPaths();
    const globalPaths = getGlobalSearchPaths();

    const resolvedWorkspace = resolveWorkspacePaths(workspacePaths);
    const resolvedGlobal = globalPaths.map(untildify);
    const allPatterns = [...resolvedWorkspace, ...resolvedGlobal];

    if (allPatterns.length > 0) {
        const pixiDirs = await findPixiDirectories(allPatterns);
        for (const dir of pixiDirs) {
            const root = path.dirname(dir);
            if (isPixiProject(root)) {
                projectRoots.push(root);
            }
        }
    }

    return [...new Set(projectRoots.map(path.normalize))];
}

function getWorkspaceSearchPaths(): string[] {
    try {
        const config = workspace.getConfiguration('pixi');
        const pixiSearchPaths = config.get<string[]>('workspaceSearchPaths');
        if (pixiSearchPaths && pixiSearchPaths.length > 0) {
            return pixiSearchPaths;
        }
        // Fallback to python-envs if configured there
        const pyConfig = workspace.getConfiguration('python-envs');
        const inspection = pyConfig.inspect<string[]>('workspaceSearchPaths');
        return inspection?.workspaceFolderValue ?? inspection?.workspaceValue ?? inspection?.defaultValue ?? [];
    } catch (error) {
        traceError('Error reading workspaceSearchPaths:', error);
        return [];
    }
}

function getGlobalSearchPaths(): string[] {
    try {
        const config = workspace.getConfiguration('pixi');
        const pixiGlobalPaths = config.get<string[]>('globalSearchPaths');
        if (pixiGlobalPaths && pixiGlobalPaths.length > 0) {
            return pixiGlobalPaths;
        }
        // Fallback to python-envs if configured there
        const pyConfig = workspace.getConfiguration('python-envs');
        const inspection = pyConfig.inspect<string[]>('globalSearchPaths');
        return inspection?.globalValue ?? [];
    } catch (error) {
        traceError('Error reading globalSearchPaths:', error);
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

const DEFAULT_SEARCH_IGNORE_PATTERNS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.venv/**',
    '**/.pixi/*/**',
];

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
    return DEFAULT_SEARCH_IGNORE_PATTERNS;
}

async function findPixiDirectories(patterns: string[]): Promise<string[]> {
    const pixiPatterns: string[] = [];

    for (const pattern of patterns) {
        const normalized = pattern.replace(/\\/g, '/').replace(/\/$/, '');
        const lastSegment = path.posix.basename(normalized);

        if (lastSegment === '.pixi') {
            pixiPatterns.push(normalized);
        } else if (lastSegment.startsWith('.')) {
            continue;
        } else {
            pixiPatterns.push(`${normalized}/**/.pixi`);
        }
    }

    if (pixiPatterns.length === 0) {
        return [];
    }

    traceVerbose('Searching for .pixi directories with patterns:', pixiPatterns);

    const ignorePatterns = getSearchIgnorePatterns();

    try {
        const results = await fg(pixiPatterns, {
            onlyDirectories: true,
            absolute: true,
            dot: true,
            followSymbolicLinks: false,
            deep: 10,
            ignore: ignorePatterns,
            suppressErrors: true,
        });

        traceVerbose(`Found ${results.length} .pixi directories`);
        return results;
    } catch (error) {
        traceError('Error searching for .pixi directories:', error);
        return [];
    }
}
