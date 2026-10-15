import * as fs from 'fs';
import * as path from 'path';
import {
    CancellationToken,
    commands,
    ConfigurationTarget,
    QuickPickItem,
    QuickPickItemKind,
    Uri,
    window,
    workspace,
    WorkspaceConfiguration,
} from 'vscode';

import { runPixi } from '../../cli/pixiCli';
import { normalizeFolderPath } from '../../common/execUtils';
import { ensureEnvironmentReady, getEnvironmentStatusBadge, sortPixiEnvironments } from '../../core/environmentRules';
import { normalizePkgName } from '../../core/packageManager';
import { PIXI_MANIFEST_NAME, PYPROJECT_MANIFEST_NAME } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiEnvironmentInfo, PixiPackage } from '../../core/types';
import type { PixiTask } from '../../providers/taskProvider';

export interface ProjectQuickPickItem extends QuickPickItem {
    projectPath: string;
}

export interface EnvQuickPickItem extends QuickPickItem {
    envName?: string;
}

export function toEnvQuickPickItem(e: PixiEnvironmentInfo): { label: string; description: string; envName: string } {
    const { icon, text } = getEnvironmentStatusBadge(e.pixiStatus);
    return {
        label: `${icon} ${e.pixiEnvName}`,
        description: text,
        envName: e.pixiEnvName,
    };
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
                label: `$(file-code) ${PIXI_MANIFEST_NAME}`,
                description: 'Dedicated Pixi manifest format (Recommended)',
                format: 'pixi' as const,
            },
            {
                label: `$(file) ${PYPROJECT_MANIFEST_NAME}`,
                description: `Standard Python ${PYPROJECT_MANIFEST_NAME} format`,
                format: 'pyproject' as const,
            },
        ],
        { placeHolder: 'Select manifest format for the new Pixi project' },
    );
    return pick?.format;
}

export function getManifestPathForFormat(folder: string, format: 'pixi' | 'pyproject'): string {
    return path.join(folder, format === 'pyproject' ? PYPROJECT_MANIFEST_NAME : PIXI_MANIFEST_NAME);
}

export interface TargetScope {
    kind: 'global' | 'feature' | 'environment';
    name?: string;
}

export interface PackageScopeResult extends TargetScope {
    isPypi: boolean;
}

export function getScopeArgs(scope?: TargetScope): string[] {
    if (scope?.kind === 'feature' && scope.name) {
        return ['-f', scope.name];
    }
    if (scope?.kind === 'environment' && scope.name) {
        return ['-e', scope.name];
    }
    return [];
}

export function formatScope(scope?: TargetScope | string): string {
    if (!scope) {
        return 'workspace';
    }
    if (typeof scope === 'string') {
        const trimmed = scope.trim();
        return !trimmed || trimmed === 'default' ? 'workspace' : `feature '${trimmed}'`;
    }
    if (scope.kind === 'feature' && scope.name) {
        return `feature '${scope.name}'`;
    }
    if (scope.kind === 'environment' && scope.name) {
        return `environment '${scope.name}'`;
    }
    return 'global dependencies';
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

export function filterNamedFeatures(features: WorkspaceListEntry[]): WorkspaceListEntry[] {
    return features.filter((f) => f.name !== 'default');
}

export function sortPixiFeatures<T extends { name: string }>(features: T[]): T[] {
    return [...features].sort((a, b) => {
        if (a.name === 'default') {
            return -1;
        }
        if (b.name === 'default') {
            return 1;
        }
        return a.name.localeCompare(b.name);
    });
}

export function getReferencingEnvs(envs: WorkspaceListEntry[], featureName: string): string[] {
    return envs.filter((e) => e.features?.includes(featureName)).map((e) => e.name);
}

export interface FeatureQuickPickItem extends QuickPickItem {
    feature: WorkspaceListEntry;
    featureName: string;
}

export function toFeatureQuickPickItem(feature: WorkspaceListEntry): FeatureQuickPickItem {
    const depCount = feature.dependencies.length + feature.pypiDependencies.length;
    const isDefault = feature.name === 'default';
    return {
        label: `$(symbol-namespace) ${feature.name}`,
        description: isDefault ? 'Default global feature' : `${depCount} dependencies`,
        feature,
        featureName: feature.name,
    };
}

export interface PickFeatureOptions {
    title?: string;
    placeHolder?: string;
    includeDefault?: boolean;
    emptyMessage?: string;
}

export async function pickPixiFeature(
    projectPath: string,
    options?: PickFeatureOptions,
): Promise<WorkspaceListEntry | undefined> {
    const features = await getWorkspaceFeatures(projectPath);
    const candidates = options?.includeDefault ? features : filterNamedFeatures(features);
    if (candidates.length === 0) {
        if (options?.emptyMessage) {
            window.showInformationMessage(options.emptyMessage);
        }
        return undefined;
    }

    const items = candidates.map(toFeatureQuickPickItem);
    const selected = await window.showQuickPick(items, {
        title: options?.title || 'Pixi: Select Feature',
        placeHolder: options?.placeHolder || 'Select a feature from project manifest',
    });
    return selected?.feature;
}

export interface ValidateIdentifierOptions {
    entityName?: string;
    existingNames?: string[];
    allowDefault?: boolean;
}

export function validatePixiIdentifier(value: string | undefined, options?: ValidateIdentifierOptions): string | null {
    const trimmed = value?.trim();
    const entity = options?.entityName || 'Identifier';
    if (!trimmed) {
        return `${entity} name cannot be empty.`;
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(trimmed)) {
        return `${entity} name must only contain alphanumeric characters, underscores, and hyphens.`;
    }
    if (options?.allowDefault !== true && trimmed === 'default') {
        return `${entity} cannot be named 'default' (reserved keyword).`;
    }
    if (options?.existingNames && options.existingNames.includes(trimmed)) {
        return `${entity} '${trimmed}' already exists in this project.`;
    }
    return null;
}

export async function getWorkspaceEnvironments(projectPath: string): Promise<WorkspaceListEntry[]> {
    try {
        const out = await runPixi(['workspace', 'environment', 'list'], { cwd: projectPath });
        return parseWorkspaceListOutput(out);
    } catch {
        return [];
    }
}

export async function findPackageScope(
    projectPath: string,
    packageName: string,
    preferredEnv?: string,
    cachedWorkspaceData?: { features: WorkspaceListEntry[]; envs: WorkspaceListEntry[] },
): Promise<PackageScopeResult | undefined> {
    const norm = normalizePkgName(packageName);
    const [features, envs] = cachedWorkspaceData
        ? [cachedWorkspaceData.features, cachedWorkspaceData.envs]
        : await Promise.all([getWorkspaceFeatures(projectPath), getWorkspaceEnvironments(projectPath)]);

    const featureMap = new Map(features.map((f) => [f.name, f]));

    const checkEntry = (
        entry: WorkspaceListEntry,
        kind: 'global' | 'feature' | 'environment',
    ): PackageScopeResult | undefined => {
        const isPypi = entry.dependencies.some((d) => normalizePkgName(d) === norm)
            ? false
            : entry.pypiDependencies.some((d) => normalizePkgName(d) === norm)
              ? true
              : undefined;
        if (isPypi === undefined) {
            return undefined;
        }
        return kind === 'global' || entry.name === 'default'
            ? { kind: 'global', isPypi }
            : { kind, name: entry.name, isPypi };
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
    const namedFeatures = filterNamedFeatures(features);
    const namedEnvs = envs.filter((e) => e.pixiEnvName !== 'default');

    if (namedFeatures.length === 0 && namedEnvs.length === 0) {
        return { kind: 'global' };
    }

    const items: ScopeQuickPickItem[] = [
        {
            label: 'Global Dependencies',
            kind: QuickPickItemKind.Separator,
        },
        {
            label: '$(globe) [default] (Global Dependencies)',
            description: 'Shared across all environments',
            scope: { kind: 'global' },
        },
    ];

    if (namedFeatures.length > 0) {
        items.push({
            label: 'Features (Reusable)',
            kind: QuickPickItemKind.Separator,
        });
        items.push(
            ...namedFeatures.map((f) => ({
                label: `$(symbol-namespace) Feature: ${f.name}`,
                description: `Reusable feature (${f.dependencies.length + f.pypiDependencies.length} dependencies)`,
                scope: { kind: 'feature' as const, name: f.name },
            })),
        );
    }

    if (namedEnvs.length > 0) {
        items.push({
            label: 'Environments (Inline Dependencies)',
            kind: QuickPickItemKind.Separator,
        });
        items.push(
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
        );
    }

    items.push(
        {
            label: 'Actions',
            kind: QuickPickItemKind.Separator,
        },
        {
            label: '$(plus) Create New Feature ...',
            description: 'Create a new feature and add this package to it',
            isCreateFeature: true,
        },
    );

    const selected = await window.showQuickPick(items, {
        title: 'Pixi: Target Scope',
        placeHolder: 'Select where to add the package (Feature or Environment)',
    });

    if (!selected) {
        return null;
    }

    if (selected.isCreateFeature) {
        const newName = await promptNewFeatureName(features);
        return newName ? { kind: 'feature', name: newName } : null;
    }

    return selected.scope ?? null;
}

export async function promptNewFeatureName(existingFeatures: WorkspaceListEntry[]): Promise<string | undefined> {
    const existingNames = existingFeatures.map((f) => f.name);
    const featureName = await window.showInputBox({
        title: 'Pixi: Create Feature',
        prompt: 'Enter a name for the new feature',
        placeHolder: 'e.g. test, dev, cuda, docs',
        validateInput: (value) => validatePixiIdentifier(value, { entityName: 'Feature', existingNames }),
    });
    return featureName?.trim() || undefined;
}

export interface ExtractedCommandContext {
    projectPath?: string;
    manifestPath?: string;
    env?: PixiEnvironmentInfo;
    envName?: string;
    pkg?: PixiPackage;
    featureName?: string;
    task?: PixiTask;
    propertyName?: string;
}

export function extractCommandContext(target?: unknown): ExtractedCommandContext {
    if (!target) {
        return {};
    }
    const projectPath = normalizeFolderPath(target);
    if (typeof target !== 'object' || target instanceof Uri) {
        return { projectPath };
    }

    const item = target as {
        pkg?: PixiPackage;
        env?: PixiEnvironmentInfo;
        project?: { manifestPath?: string };
        featureName?: string;
        feature?: { name?: string };
        task?: PixiTask;
        name?: string;
        propertyName?: string;
    };

    const task =
        item.task ||
        (!('manifestPath' in item) && 'name' in item && 'projectPath' in item && typeof item.name === 'string'
            ? (item as PixiTask)
            : undefined);

    return {
        projectPath,
        manifestPath: item.project?.manifestPath,
        env: item.env,
        envName: item.env?.pixiEnvName,
        pkg: item.pkg,
        featureName: item.featureName || item.feature?.name,
        task,
        propertyName: item.propertyName,
    };
}

export function extractTask(target?: unknown): PixiTask | undefined {
    return extractCommandContext(target).task;
}

export function extractEnvironmentName(target?: unknown, preset?: string): string | undefined {
    return preset?.trim() || extractCommandContext(target).envName;
}

export function extractFeatureName(target?: unknown, preset?: string): string | undefined {
    return preset?.trim() || extractCommandContext(target).featureName;
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

    if (envs.length <= 1) {
        return envs[0]?.pixiEnvName === 'default' ? undefined : envs[0]?.pixiEnvName;
    }

    const namedEnvs = envs.filter((e) => e.pixiEnvName !== 'default');
    const items: EnvQuickPickItem[] = [
        {
            label: '$(globe) Default',
            description: 'Default environment',
            envName: undefined,
        },
        ...namedEnvs.map(toEnvQuickPickItem),
    ];

    const selected = await window.showQuickPick(items, {
        title: 'Pixi: Select Environment',
        placeHolder: placeholder || 'Select environment to inspect',
    });

    return selected ? selected.envName : null;
}

export async function resolveTargetFolder(targetItem?: unknown, placeHolder?: string): Promise<string | undefined> {
    const direct = normalizeFolderPath(targetItem);
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

/**
 * Ensures at least one Pixi project exists in the workspace.
 * Displays a standardized warning notification if none are found.
 */
export function ensureHasPixiProjects(manager: PixiProjectManager): boolean {
    if (manager.getProjectPaths().length === 0) {
        window.showWarningMessage('No Pixi projects found in the current workspace.');
        return false;
    }
    return true;
}

export async function pickPixiProject(
    manager: PixiProjectManager,
    placeHolder: string,
    context?: unknown,
): Promise<string | undefined> {
    const direct = normalizeFolderPath(context);

    if (direct) {
        const matched = manager.findProjectForUri(Uri.file(direct));
        if (matched) {
            return matched;
        }
    }

    if (!ensureHasPixiProjects(manager)) {
        return undefined;
    }

    const projectPaths = manager.getProjectPaths();

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

export async function openDocumentIfExists(filePath: string): Promise<boolean> {
    if (!fs.existsSync(filePath)) {
        return false;
    }
    const doc = await workspace.openTextDocument(Uri.file(filePath));
    await window.showTextDocument(doc);
    return true;
}

export async function updateConfigurationValue<T>(
    config: WorkspaceConfiguration,
    key: string,
    value: T,
): Promise<void> {
    const inspect = config.inspect<T>(key);
    const target =
        inspect?.workspaceFolderValue !== undefined
            ? ConfigurationTarget.WorkspaceFolder
            : inspect?.workspaceValue !== undefined
              ? ConfigurationTarget.Workspace
              : ConfigurationTarget.Global;
    await config.update(key, value, target);
}

export interface WorkspaceOrFeatureScopeOptions {
    title: string;
    placeHolder: string;
    globalLabel: string;
    globalDescription: string;
    featureDescription: (featureName: string) => string;
}

export async function resolveWorkspaceOrFeatureScope(
    projectPath: string,
    options: WorkspaceOrFeatureScopeOptions,
    targetItem?: unknown,
    presetFeature?: string,
): Promise<string | undefined | null> {
    const contextFeature = extractFeatureName(targetItem, presetFeature);
    if (contextFeature) {
        return contextFeature === 'default' ? undefined : contextFeature;
    }

    const features = await getWorkspaceFeatures(projectPath);
    const namedFeatures = filterNamedFeatures(features);
    if (namedFeatures.length === 0) {
        return undefined;
    }

    interface ScopePickItem extends QuickPickItem {
        featureName?: string;
    }

    const items: ScopePickItem[] = [
        {
            label: 'Workspace Scope',
            kind: QuickPickItemKind.Separator,
        },
        {
            label: options.globalLabel,
            description: options.globalDescription,
            featureName: undefined,
        },
        {
            label: 'Feature Scope',
            kind: QuickPickItemKind.Separator,
        },
        ...namedFeatures.map((f) => ({
            label: `$(symbol-namespace) Feature: ${f.name}`,
            description: options.featureDescription(f.name),
            featureName: f.name,
        })),
    ];

    const selected = await window.showQuickPick(items, {
        title: options.title,
        placeHolder: options.placeHolder,
    });

    if (!selected) {
        return null;
    }
    return selected.featureName;
}

export interface PickEnvironmentOptions {
    title?: string;
    placeHolder?: string;
    /** If true, returns immediately if there is only 1 environment (default: true) */
    autoSelectSingle?: boolean;
    /** Setting key to check for default environment (e.g. 'terminal.defaultEnvironment') */
    defaultEnvConfigKey?: string;
    token?: CancellationToken;
}

export async function pickPixiEnvironment(
    manager: PixiProjectManager,
    targetProjectPath?: string,
    options?: PickEnvironmentOptions,
): Promise<PixiEnvironmentInfo | undefined> {
    const rawEnvs = targetProjectPath
        ? manager.getEnvironmentsForProject(targetProjectPath)
        : manager.getAllEnvironments();

    if (rawEnvs.length === 0) {
        const choice = await window.showWarningMessage(
            'No Pixi environments found in current workspace. Would you like to initialize a Pixi project?',
            'Initialize Project',
        );
        if (choice === 'Initialize Project') {
            await commands.executeCommand('pixi.init');
        }
        return undefined;
    }

    const envs = sortPixiEnvironments(rawEnvs);

    if (options?.autoSelectSingle !== false && envs.length === 1) {
        return envs[0];
    }

    const activeUri = window.activeTextEditor?.document?.uri;
    const configScope = targetProjectPath ? Uri.file(targetProjectPath) : activeUri;
    const config = workspace.getConfiguration('pixi', configScope);
    const defaultEnvSetting = options?.defaultEnvConfigKey
        ? config.get<string>(options.defaultEnvConfigKey)?.trim()
        : undefined;

    if (defaultEnvSetting) {
        const activeProjectPath = !targetProjectPath && activeUri ? manager.findProjectForUri(activeUri) : undefined;
        const matching = envs.filter((e) => e.pixiEnvName === defaultEnvSetting);
        const matchedEnv =
            (activeProjectPath ? matching.find((e) => e.projectPath === activeProjectPath) : undefined) ??
            (matching.length === 1 ? matching[0] : undefined);
        if (matchedEnv) {
            return matchedEnv;
        }
    }

    interface FullEnvQuickPickItem extends QuickPickItem {
        env: PixiEnvironmentInfo;
    }

    const items: FullEnvQuickPickItem[] = envs.map((env) => {
        const { icon, text } = getEnvironmentStatusBadge(env.pixiStatus);
        return {
            label: `${icon} ${env.pixiEnvName}`,
            description: text,
            detail: env.statusReason || env.prefix,
            env,
        };
    });

    const selected = await window.showQuickPick(
        items,
        {
            placeHolder: options?.placeHolder || 'Select a Pixi environment',
            title: options?.title || 'Pixi: Select Environment',
        },
        options?.token,
    );

    return selected?.env;
}

export interface PickProjectEnvironmentOptions {
    title?: string;
    placeHolder?: string;
    filter?: (env: PixiEnvironmentInfo) => boolean;
    includeAllOption?: boolean;
    allOptionLabel?: string;
    allOptionDescription?: string;
    emptyMessage?: string;
}

export async function pickProjectEnvironmentName(
    manager: PixiProjectManager,
    projectPath: string,
    options: PickProjectEnvironmentOptions & { includeAllOption: true },
): Promise<string | null | undefined>;
export async function pickProjectEnvironmentName(
    manager: PixiProjectManager,
    projectPath: string,
    options?: PickProjectEnvironmentOptions,
): Promise<string | undefined>;
export async function pickProjectEnvironmentName(
    manager: PixiProjectManager,
    projectPath: string,
    options?: PickProjectEnvironmentOptions,
): Promise<string | null | undefined> {
    const projectName = manager.getProjectName(projectPath);
    const envs = manager.getEnvironmentsForProject(projectPath);
    const filteredEnvs = options?.filter ? envs.filter(options.filter) : envs;

    if (filteredEnvs.length === 0) {
        if (options?.emptyMessage) {
            window.showInformationMessage(options.emptyMessage);
        }
        return undefined;
    }

    interface EnvPickItem extends QuickPickItem {
        envName?: string | null;
    }

    const items: EnvPickItem[] = [];
    if (options?.includeAllOption) {
        items.push({
            label: options.allOptionLabel || '$(globe) All Environments',
            description: options.allOptionDescription || `All ${filteredEnvs.length} environments in ${projectName}`,
            envName: null,
        });
    }

    items.push(...filteredEnvs.map(toEnvQuickPickItem));

    const selected = await window.showQuickPick(items, {
        title: options?.title || `Pixi: Select Environment (${projectName})`,
        placeHolder: options?.placeHolder || 'Select environment',
    });

    if (!selected) {
        return undefined;
    }
    return selected.envName ?? null;
}

export interface ResolveEnvironmentOptions extends PickEnvironmentOptions {
    /** Action description for error reporting in ensureEnvironmentReady, e.g. 'open terminal for environment' */
    action: string;
    /** Custom installation prompt message for uninstalled environments */
    customInstallPrompt?: string;
}

/**
 * All-in-one helper to resolve and guard a ready Pixi environment:
 * 1. Extracts environment directly from targetItem (e.g. tree item context menu) if present.
 * 2. If no environment context is provided, prompts the user via pickPixiEnvironment.
 * 3. Enforces ensureEnvironmentReady on the resolved environment.
 * 4. Returns the verified PixiEnvironmentInfo, or undefined if cancelled or not ready.
 */
export async function resolveReadyEnvironment(
    manager: PixiProjectManager,
    targetItem?: unknown,
    options?: ResolveEnvironmentOptions,
): Promise<PixiEnvironmentInfo | undefined> {
    const ctx = extractCommandContext(targetItem);
    let env = ctx.env;

    if (!env) {
        const folder = ctx.projectPath;
        const targetProjectPath = folder ? manager.findProjectForUri(Uri.file(folder)) || folder : undefined;
        env = await pickPixiEnvironment(manager, targetProjectPath, options);
    }

    if (!env) {
        return undefined;
    }

    const isReady = await ensureEnvironmentReady(env, {
        action: options?.action,
        customInstallPrompt: options?.customInstallPrompt,
    });
    return isReady ? env : undefined;
}
