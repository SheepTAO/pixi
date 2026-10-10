import * as fs from 'fs';
import * as path from 'path';
import { workspace } from 'vscode';

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
 * Resolves opened workspace folders and returns deduplicated Pixi project root paths.
 */
export async function resolvePixiProjectPaths(): Promise<string[]> {
    if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
        return [];
    }

    const projectRoots: string[] = [];
    for (const folder of workspace.workspaceFolders) {
        if (isPixiProject(folder.uri.fsPath)) {
            projectRoots.push(path.normalize(folder.uri.fsPath));
        }
    }

    return [...new Set(projectRoots)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
