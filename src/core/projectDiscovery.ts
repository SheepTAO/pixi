import * as path from 'path';
import { DocumentFilter, TextDocument, Uri } from 'vscode';

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

export interface WorkspaceChannelEntry {
    channel: string;
    feature?: string;
}
