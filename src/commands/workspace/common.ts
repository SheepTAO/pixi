import * as fs from 'fs';
import * as path from 'path';
import { QuickPickItem, Uri, window, workspace } from 'vscode';

import { normalizeFolderPath } from '../../common/execUtils';
import { getEnvironmentStatusBadge } from '../../core/environmentRules';
import { isPixiProject } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiEnvironmentInfo } from '../../core/types';

export interface ProjectQuickPickItem extends QuickPickItem {
    projectPath: string;
}

export interface EnvQuickPickItem extends QuickPickItem {
    envName?: string;
}

export async function pickManifestFormat(target?: Uri | string): Promise<'pixi' | 'pyproject' | undefined> {
    const targetUri = typeof target === 'string' ? Uri.file(target) : target;
    const config = workspace.getConfiguration('pixi', targetUri);
    const defaultFormat = config.get<'ask' | 'pixi' | 'pyproject'>('defaultManifestFormat', 'ask');
    if (defaultFormat === 'pixi' || defaultFormat === 'pyproject') {
        return defaultFormat;
    }

    const pick = await window.showQuickPick(
        [
            {
                label: '$(file-code) pixi.toml',
                description: 'Dedicated Pixi manifest format (Recommended)',
                format: 'pixi' as const,
            },
            {
                label: '$(file) pyproject.toml',
                description: 'Standard Python pyproject.toml format',
                format: 'pyproject' as const,
            },
        ],
        { placeHolder: 'Select manifest format for the new Pixi project' },
    );
    return pick?.format;
}

export function getManifestPathForFormat(folder: string, format: 'pixi' | 'pyproject'): string {
    return path.join(folder, format === 'pyproject' ? 'pyproject.toml' : 'pixi.toml');
}

export async function pickTargetEnvironment(
    envs: PixiEnvironmentInfo[],
    action: 'add' | 'remove' | 'inspect',
    placeholder?: string,
): Promise<string | undefined | null> {
    if (envs.length <= 1) {
        return action === 'add' ? undefined : envs[0]?.pixiEnvName === 'default' ? undefined : envs[0]?.pixiEnvName;
    }

    const isAdd = action === 'add';
    const isInspect = action === 'inspect';
    const namedEnvs = envs.filter((e) => e.pixiEnvName !== 'default');
    const items: EnvQuickPickItem[] = [
        {
            label: '$(globe) Default',
            description: isAdd
                ? 'Default environment / feature (available to all environments)'
                : 'Default environment',
            envName: undefined,
        },
        ...namedEnvs.map((e) => {
            const { icon, text } = getEnvironmentStatusBadge(e.pixiStatus);
            return {
                label: `${icon} ${e.pixiEnvName}`,
                description: text ? `${e.projectName} ${text}` : e.projectName,
                envName: e.pixiEnvName,
            };
        }),
    ];

    const title = isInspect ? 'Pixi: Select Environment' : `Pixi: Target Environment${isAdd ? ' (Optional)' : ''}`;
    const defaultPlaceholder = isInspect
        ? 'Select environment to inspect'
        : `Select target environment or feature to ${action} package`;

    const selected = await window.showQuickPick(items, {
        title,
        placeHolder: placeholder || defaultPlaceholder,
    });

    if (!selected) {
        return null;
    }
    return selected.envName;
}

export interface EnvironmentContextCandidate {
    pixiEnvName?: string;
    envName?: string;
    env?: { pixiEnvName?: string };
}

export function extractEnvironmentName(target?: unknown): string | undefined {
    if (!target) {
        return undefined;
    }
    if (typeof target === 'string') {
        const trimmed = target.trim();
        if (trimmed && !trimmed.includes('/') && !trimmed.includes('\\')) {
            return trimmed;
        }
        return undefined;
    }
    if (typeof target === 'object') {
        const item = target as EnvironmentContextCandidate;
        return item.pixiEnvName || item.env?.pixiEnvName || item.envName;
    }
    return undefined;
}

export async function resolveTargetEnvironment(
    envs: PixiEnvironmentInfo[],
    targetItem?: unknown,
    placeholder?: string,
): Promise<string | undefined | null> {
    const directEnvName = extractEnvironmentName(targetItem);
    if (directEnvName) {
        return directEnvName;
    }

    if (envs.length > 1) {
        return pickTargetEnvironment(envs, 'inspect', placeholder);
    }
    if (envs.length === 1 && envs[0].pixiEnvName !== 'default') {
        return envs[0].pixiEnvName;
    }
    return undefined;
}

export async function resolveTargetFolder(folderUri?: unknown, placeHolder?: string): Promise<string | undefined> {
    const direct = normalizeFolderPath(folderUri);
    if (direct) {
        return direct;
    }

    if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
        return undefined;
    }

    if (workspace.workspaceFolders.length === 1) {
        return workspace.workspaceFolders[0].uri.fsPath;
    }

    const pick = await window.showWorkspaceFolderPick({
        placeHolder: placeHolder || 'Select workspace folder',
    });
    return pick?.uri.fsPath;
}

export async function pickPixiProject(
    manager: PixiProjectManager,
    placeHolder: string,
    context?: unknown,
): Promise<string | undefined> {
    const direct = normalizeFolderPath(context);
    const projectPaths = manager.getProjectPaths();

    if (direct) {
        const matched = manager.findProjectForUri(Uri.file(direct));
        if (matched) {
            return matched;
        }
        if (isPixiProject(direct)) {
            return direct;
        }
    }

    if (projectPaths.length === 0) {
        window.showWarningMessage('No Pixi projects found in the current workspace.');
        return undefined;
    }

    if (projectPaths.length === 1) {
        return projectPaths[0];
    }

    const items: ProjectQuickPickItem[] = projectPaths.map((p) => ({
        label: path.basename(p),
        description: p,
        projectPath: p,
    }));

    const selected = await window.showQuickPick(items, {
        placeHolder,
        title: 'Pixi: Select Project',
    });

    return selected?.projectPath;
}

export async function openDocumentIfExists(filePath: string): Promise<void> {
    if (fs.existsSync(filePath)) {
        const doc = await workspace.openTextDocument(Uri.file(filePath));
        await window.showTextDocument(doc);
    }
}
