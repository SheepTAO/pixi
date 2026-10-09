import * as fs from 'fs';
import * as path from 'path';
import { QuickPickItem, Uri, window, workspace } from 'vscode';

import { runPixi } from '../../cli/pixiCli';
import { normalizeFolderPath, normalizeLocationPath } from '../../common/execUtils';
import { getEnvironmentStatusBadge } from '../../core/environmentRules';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiEnvironmentInfo, PixiPackage } from '../../core/types';

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

export interface TargetScope {
    kind: 'global' | 'feature' | 'environment';
    name?: string;
}

export interface WorkspaceListEntry {
    name: string;
    features?: string[];
    dependencies: string[];
    pypiDependencies: string[];
}

export function parseWorkspaceListOutput(text: string): WorkspaceListEntry[] {
    const entries: WorkspaceListEntry[] = [];
    let current: WorkspaceListEntry | null = null;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trimEnd();
        const itemMatch = line.match(/^-\s+([^:]+)(?::\s*)?$/);
        if (itemMatch) {
            current = {
                name: itemMatch[1].trim(),
                dependencies: [],
                pypiDependencies: [],
            };
            entries.push(current);
            continue;
        }
        if (!current) {
            continue;
        }
        const featMatch = line.match(/^\s+features:\s*(.+)$/);
        if (featMatch) {
            current.features = featMatch[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            continue;
        }
        const depMatch = line.match(/^\s+dependencies:\s*(.+)$/);
        if (depMatch) {
            current.dependencies = depMatch[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            continue;
        }
        const pypiMatch = line.match(/^\s+pypi-dependencies:\s*(.+)$/);
        if (pypiMatch) {
            current.pypiDependencies = pypiMatch[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            continue;
        }
    }
    return entries;
}

export async function getWorkspaceFeatures(projectPath: string): Promise<WorkspaceListEntry[]> {
    try {
        const out = await runPixi(['workspace', 'feature', 'list'], { cwd: projectPath });
        return parseWorkspaceListOutput(out);
    } catch {
        return [];
    }
}

export async function getWorkspaceEnvironments(projectPath: string): Promise<WorkspaceListEntry[]> {
    try {
        const out = await runPixi(['workspace', 'environment', 'list'], { cwd: projectPath });
        return parseWorkspaceListOutput(out);
    } catch {
        return [];
    }
}

export interface PackageScopeResult {
    kind: 'global' | 'feature' | 'environment';
    scopeName?: string;
    isPypi: boolean;
}

export async function findPackageScope(
    projectPath: string,
    packageName: string,
    preferredEnv?: string,
): Promise<PackageScopeResult | undefined> {
    const norm = packageName.toLowerCase().replace(/[-_.]+/g, '-');
    const [features, envs] = await Promise.all([
        getWorkspaceFeatures(projectPath),
        getWorkspaceEnvironments(projectPath),
    ]);

    const featureMap = new Map<string, WorkspaceListEntry>();
    for (const f of features) {
        featureMap.set(f.name, f);
    }

    const checkEntry = (
        entry: WorkspaceListEntry,
        kind: 'global' | 'feature' | 'environment',
    ): PackageScopeResult | undefined => {
        if (entry.dependencies.some((d) => d.toLowerCase().replace(/[-_.]+/g, '-') === norm)) {
            return kind === 'global' || entry.name === 'default'
                ? { kind: 'global', isPypi: false }
                : { kind, scopeName: entry.name, isPypi: false };
        }
        if (entry.pypiDependencies.some((d) => d.toLowerCase().replace(/[-_.]+/g, '-') === norm)) {
            return kind === 'global' || entry.name === 'default'
                ? { kind: 'global', isPypi: true }
                : { kind, scopeName: entry.name, isPypi: true };
        }
        return undefined;
    };

    // 1. If preferredEnv is provided and not default, check target environment context first
    if (preferredEnv && preferredEnv !== 'default') {
        const targetEnvEntry = envs.find((e) => e.name === preferredEnv);
        if (targetEnvEntry) {
            // Check inline dependencies for this environment
            const inlineMatch = checkEntry(targetEnvEntry, 'environment');
            if (inlineMatch) {
                return inlineMatch;
            }
            // Check features referenced by this environment
            for (const featName of targetEnvEntry.features || []) {
                const featEntry = featureMap.get(featName);
                if (featEntry) {
                    const featMatch = checkEntry(featEntry, 'feature');
                    if (featMatch) {
                        return featMatch;
                    }
                }
            }
        }
    }

    // 2. Check all features (including default/global)
    for (const f of features) {
        const res = checkEntry(f, 'feature');
        if (res) {
            return res;
        }
    }

    // 3. Check all environments for inline dependencies
    for (const e of envs) {
        const res = checkEntry(e, 'environment');
        if (res) {
            return res;
        }
    }

    return undefined;
}

export interface ScopeQuickPickItem extends QuickPickItem {
    scope?: TargetScope;
    isCreateFeature?: boolean;
}

export async function pickTargetScope(
    projectPath: string,
    envs: PixiEnvironmentInfo[],
    presetScopeName?: string,
): Promise<TargetScope | null> {
    if (presetScopeName) {
        if (presetScopeName === 'default') {
            return { kind: 'global' };
        }
        const existingFeatures = await getWorkspaceFeatures(projectPath);
        if (existingFeatures.some((f) => f.name === presetScopeName)) {
            return { kind: 'feature', name: presetScopeName };
        }
        const items: ScopeQuickPickItem[] = [
            {
                label: `$(symbol-namespace) Feature: ${presetScopeName}`,
                description: 'Recommended: add to reusable feature',
                scope: { kind: 'feature', name: presetScopeName },
            },
            {
                label: `$(server-environment) Environment: ${presetScopeName}`,
                description: `Add inline private dependency to environment '${presetScopeName}'`,
                scope: { kind: 'environment', name: presetScopeName },
            },
            {
                label: '$(globe) [default] (Global Dependencies)',
                description: 'Available to all environments',
                scope: { kind: 'global' },
            },
        ];
        const selected = await window.showQuickPick(items, {
            title: 'Pixi: Select Target Scope',
            placeHolder: `Select where to add package for '${presetScopeName}'`,
        });
        return selected?.scope ?? null;
    }

    const features = await getWorkspaceFeatures(projectPath);
    const namedFeatures = features.filter((f) => f.name !== 'default');
    const namedEnvs = envs.filter((e) => e.pixiEnvName !== 'default');

    if (namedFeatures.length === 0 && namedEnvs.length === 0) {
        return { kind: 'global' };
    }

    const items: ScopeQuickPickItem[] = [
        {
            label: '$(globe) [default] (Global Dependencies)',
            description: 'Shared across all environments',
            scope: { kind: 'global' },
        },
        ...namedFeatures.map((f) => ({
            label: `$(symbol-namespace) Feature: ${f.name}`,
            description: `Reusable feature (${f.dependencies.length + f.pypiDependencies.length} dependencies)`,
            scope: { kind: 'feature' as const, name: f.name },
        })),
        ...namedEnvs.map((e) => {
            const { icon, text } = getEnvironmentStatusBadge(e.pixiStatus);
            return {
                label: `${icon} Environment: ${e.pixiEnvName}`,
                description: text
                    ? `Inline dependency for ${e.pixiEnvName} (${text})`
                    : `Inline dependency for ${e.pixiEnvName}`,
                scope: { kind: 'environment' as const, name: e.pixiEnvName },
            };
        }),
        {
            label: '$(plus) Create New Feature ...',
            description: 'Create a new feature and add this package to it',
            isCreateFeature: true,
        },
    ];

    const selected = await window.showQuickPick(items, {
        title: 'Pixi: Target Scope',
        placeHolder: 'Select where to add the package (Feature or Environment)',
    });

    if (!selected) {
        return null;
    }

    if (selected.isCreateFeature) {
        const newName = await window.showInputBox({
            title: 'Pixi: Create Feature',
            prompt: 'Enter a name for the new feature',
            placeHolder: 'e.g. test, dev, cuda, docs',
            validateInput: (value) => {
                const trimmed = value?.trim();
                if (!trimmed) {
                    return 'Feature name cannot be empty.';
                }
                if (!/^[a-zA-Z0-9_\-]+$/.test(trimmed)) {
                    return 'Feature name must only contain alphanumeric characters, underscores, and hyphens.';
                }
                if (trimmed === 'default' || features.some((f) => f.name === trimmed)) {
                    return `Feature '${trimmed}' already exists.`;
                }
                return null;
            },
        });
        if (!newName?.trim()) {
            return null;
        }
        return { kind: 'feature', name: newName.trim() };
    }

    return selected.scope ?? null;
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

export interface ExtractedCommandContext {
    projectPath?: string;
    manifestPath?: string;
    envName?: string;
    env?: PixiEnvironmentInfo;
    pkg?: PixiPackage;
    pkgName?: string;
}

export type EnvironmentContextCandidate = ExtractedCommandContext;

export function extractCommandContext(target?: unknown): ExtractedCommandContext {
    if (!target) {
        return {};
    }
    if (typeof target === 'string') {
        const trimmed = target.trim();
        if (trimmed.includes('/') || trimmed.includes('\\')) {
            return { projectPath: trimmed };
        }
        return { envName: trimmed, pkgName: trimmed };
    }
    if (target instanceof Uri) {
        return { projectPath: target.fsPath };
    }
    if (typeof target === 'object') {
        const item = target as {
            pkg?: PixiPackage;
            env?: PixiEnvironmentInfo;
            projectPath?: string;
            manifestPath?: string;
            project?: { projectPath?: string; manifestPath?: string };
            pixiEnvName?: string;
            envName?: string;
            name?: string;
            uri?: Uri;
        };

        const projectPath = normalizeLocationPath(target);
        const manifestPath = item.manifestPath || item.project?.manifestPath || item.env?.manifestPath;
        const envName = item.pixiEnvName || item.env?.pixiEnvName || item.envName;
        const pkg = item.pkg;
        const pkgName = item.pkg?.name || item.name;

        return {
            projectPath,
            manifestPath,
            envName,
            env: item.env,
            pkg,
            pkgName,
        };
    }
    return {};
}

export function extractEnvironmentName(target?: unknown): string | undefined {
    return extractCommandContext(target).envName;
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
