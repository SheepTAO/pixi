import * as fs from 'fs';
import * as path from 'path';
import { DocumentFilter, TextDocument, Uri, workspace } from 'vscode';

export const PIXI_MANIFEST_NAME = 'pixi.toml';
export const PYPROJECT_MANIFEST_NAME = 'pyproject.toml';
export const SUPPORTED_MANIFEST_NAMES = [PIXI_MANIFEST_NAME, PYPROJECT_MANIFEST_NAME] as const;
export type SupportedManifestName = (typeof SUPPORTED_MANIFEST_NAMES)[number];

export const LOCKFILE_NAME = 'pixi.lock';
export const DEFAULT_CONDA_CHANNEL = 'conda-forge';

/**
 * Standard document filter selectors for Pixi and pyproject manifests.
 */
export const MANIFEST_SELECTORS: readonly DocumentFilter[] = SUPPORTED_MANIFEST_NAMES.map((name) => ({
    scheme: 'file',
    pattern: `**/${name}`,
}));

/**
 * Resolves the lockfile path ('pixi.lock') for a given project directory.
 */
export function getLockfilePath(projectPath: string): string {
    return path.join(projectPath, LOCKFILE_NAME);
}

/**
 * Checks if a document, Uri, or file path corresponds to a pyproject.toml manifest.
 */
export function isPyproject(target?: TextDocument | Uri | string | null): boolean {
    if (!target) {
        return false;
    }
    const p = typeof target === 'string' ? target : 'uri' in target ? target.uri.fsPath : target.fsPath;
    return path.basename(p) === PYPROJECT_MANIFEST_NAME;
}

/**
 * Checks whether a TOML section header belongs to Pixi configuration.
 * In pyproject.toml, Pixi sections must start with 'tool.pixi.'.
 * In pixi.toml, all declared sections are Pixi-managed.
 */
export function isPixiManifestSection(section?: string | null, isPyprojectDoc?: boolean): boolean {
    if (!section) {
        return false;
    }
    return !isPyprojectDoc || section === 'tool.pixi' || section.startsWith('tool.pixi.');
}

export { getProjectKey } from '../common/execUtils';

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
    for (const name of SUPPORTED_MANIFEST_NAMES) {
        const fullPath = path.join(folderPath, name);
        if (!fs.existsSync(fullPath)) {
            continue;
        }
        if (name === PYPROJECT_MANIFEST_NAME) {
            try {
                const content = fs.readFileSync(fullPath, 'utf8');
                if (/(?:^|\n)\s*\[tool\.pixi/.test(content)) {
                    return fullPath;
                }
            } catch {
                continue;
            }
        } else {
            return fullPath;
        }
    }
    return undefined;
}

export interface WorkspaceChannelEntry {
    channel: string;
    feature?: string;
}

const GLOBAL_WORKSPACE_HEADERS = new Set(['workspace', 'project', 'tool.pixi.workspace', 'tool.pixi.project']);
const FEATURE_HEADER_RE = /^(?:tool\.pixi\.)?feature\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/;
const CHANNELS_ARRAY_RE = /^\s*channels\s*=\s*\[([\s\S]*?)\]/m;
const CHANNEL_ITEM_RE = /\{[^}]*?\bchannel\s*=\s*(?:"([^"]+)"|'([^']+)')[^}]*\}|(?:"([^"]+)"|'([^']+)')/g;

/**
 * Parses configured Conda channels (both global workspace and feature-scoped) from TOML manifest text.
 */
function parseManifestChannels(text: string): WorkspaceChannelEntry[] {
    const uncommented = text.replace(
        /("(?:\\.|[^"\\])*"|'[^']*')|#.*$/gm,
        (_, quoted: string | undefined) => quoted ?? '',
    );
    const entries: WorkspaceChannelEntry[] = [];
    const seenScopeEntries = new Set<string>();

    const parseSection = (header: string, body: string): void => {
        let featureScope: string | undefined;
        if (!GLOBAL_WORKSPACE_HEADERS.has(header)) {
            const featMatch = header.match(FEATURE_HEADER_RE);
            if (!featMatch) {
                return;
            }
            featureScope = featMatch[1] || featMatch[2] || featMatch[3];
        }

        const channelsArrayMatch = body.match(CHANNELS_ARRAY_RE);
        if (!channelsArrayMatch) {
            return;
        }

        for (const m of channelsArrayMatch[1].matchAll(CHANNEL_ITEM_RE)) {
            const channel = (m[1] || m[2] || m[3] || m[4] || '').trim();
            const scopeKey = `${featureScope ?? ''}::${channel}`;
            if (channel && !seenScopeEntries.has(scopeKey)) {
                seenScopeEntries.add(scopeKey);
                entries.push({ channel, feature: featureScope });
            }
        }
    };

    let currentHeader = '';
    let sectionStart = 0;
    for (const match of uncommented.matchAll(/^\s*\[([^\[\]]+)\]\s*$/gm)) {
        if (currentHeader) {
            parseSection(currentHeader, uncommented.slice(sectionStart, match.index));
        }
        currentHeader = match[1].trim();
        sectionStart = (match.index ?? 0) + match[0].length;
    }
    if (currentHeader) {
        parseSection(currentHeader, uncommented.slice(sectionStart));
    }

    return entries;
}

/**
 * Reads configured Conda channel entries (with scope metadata) from pixi.toml or pyproject.toml.
 */
export function getWorkspaceChannels(projectPath: string): WorkspaceChannelEntry[] {
    const manifestFile = findManifestPath(projectPath);
    if (!manifestFile) {
        return [];
    }
    try {
        return parseManifestChannels(fs.readFileSync(manifestFile, 'utf8'));
    } catch {
        return [];
    }
}

/**
 * Reads configured Conda channels from pixi.toml or pyproject.toml in a project directory.
 */
export function getProjectConfiguredChannels(projectPath: string): string[] {
    return Array.from(new Set(getWorkspaceChannels(projectPath).map((e) => e.channel)));
}

/**
 * Resolves opened workspace folders and returns deduplicated Pixi project root paths.
 */
export function resolvePixiProjectPaths(): string[] {
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
