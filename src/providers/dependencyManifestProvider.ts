import * as fs from 'fs';
import {
    CancellationToken,
    commands,
    Definition,
    DefinitionProvider,
    Disposable,
    Event,
    EventEmitter,
    Hover,
    HoverProvider,
    InlayHint,
    InlayHintKind,
    InlayHintsProvider,
    languages,
    Location,
    MarkdownString,
    Position,
    Range,
    TextDocument,
    Uri,
    window,
    workspace,
} from 'vscode';

import { PixiExtensionApi } from '../api';
import { pickPixiProject } from '../commands/workspace/common';
import { encodeCommandArg, escapeRegex, revealRangeInEditor } from '../common/execUtils';
import { getPrefixDevPackageUrl, getPypiPackageUrl, normalizePkgName } from '../core/packageManager';
import {
    DEFAULT_CONDA_CHANNEL,
    getLockfilePath,
    isPixiManifestSection,
    isPyproject,
    LOCKFILE_NAME,
    MANIFEST_SELECTORS,
} from '../core/projectDiscovery';
import { PixiProjectManager } from '../core/projectManager';
import { PixiPackage } from '../core/types';

export interface ParsedDependency {
    name: string;
    section: string;
    line: number;
    nameRange: Range;
    valueRange: Range;
    insertPosition: Position;
    requestedSpec?: string;
}

interface LockfileCache {
    mtimeMs: number;
    lines: string[];
}

const lockfileCache = new Map<string, LockfileCache>();

/**
 * Reads lines of pixi.lock with mtime-based in-memory caching.
 */
async function getLockfileLines(lockPath: string): Promise<string[] | undefined> {
    try {
        const stats = await fs.promises.stat(lockPath);
        const cached = lockfileCache.get(lockPath);
        if (cached && cached.mtimeMs === stats.mtimeMs) {
            return cached.lines;
        }
        const content = await fs.promises.readFile(lockPath, 'utf8');
        const lines = content.split(/\r?\n/);
        lockfileCache.set(lockPath, { mtimeMs: stats.mtimeMs, lines });
        return lines;
    } catch {
        lockfileCache.delete(lockPath);
        return undefined;
    }
}

function findPackageLineInLines(lines: string[], pkgName: string): number {
    const namePattern = escapeRegex(pkgName).replace(/[-_]/g, '[-_]');

    const regCondaOrPypi = new RegExp(
        `^\\s*-\\s*(?:conda|pypi):\\s*.*[/\\\\]${namePattern}(?:-[0-9]|[/\\\\]?\\s*$)`,
        'i',
    );
    const regName = new RegExp(`^\\s*name:\\s*["']?${namePattern}["']?\\s*$`, 'i');

    const packagesIndex = lines.findIndex((l) => /^packages:\s*$/.test(l));
    const searchStartIndex = packagesIndex !== -1 ? packagesIndex : 0;

    // 1. Prioritize detailed package definitions in the packages section
    for (let i = searchStartIndex; i < lines.length; i++) {
        if (regCondaOrPypi.test(lines[i]) || regName.test(lines[i])) {
            return i;
        }
    }

    // 2. Fallback to environment references before the packages section
    for (let i = 0; i < searchStartIndex; i++) {
        if (regCondaOrPypi.test(lines[i]) || regName.test(lines[i])) {
            return i;
        }
    }

    return -1;
}

function getLockedVersionFromLines(lines: string[], pkgName: string): string | undefined {
    const lineIndex = findPackageLineInLines(lines, pkgName);
    if (lineIndex < 0) {
        return undefined;
    }
    const targetLine = lines[lineIndex];
    const namePattern = escapeRegex(pkgName).replace(/[-_]/g, '[-_]');

    const urlMatch = targetLine.match(
        new RegExp(
            `[/\\\\]${namePattern}-([0-9][^/\\\\\\s]*?)(?:-[^/\\\\\\s]+)?\\.(?:conda|tar\\.bz2|whl|tar\\.gz)`,
            'i',
        ),
    );
    if (urlMatch && urlMatch[1]) {
        const rawVer = urlMatch[1];
        const lastDash = rawVer.lastIndexOf('-');
        return lastDash > 0 ? rawVer.substring(0, lastDash) : rawVer;
    }

    const start = Math.max(0, lineIndex - 3);
    const end = Math.min(lines.length, lineIndex + 8);
    for (let i = start; i < end; i++) {
        const vMatch = lines[i].match(/^\s*version:\s*["']?([^"'\s]+)["']?/);
        if (vMatch && vMatch[1]) {
            return vMatch[1];
        }
    }

    return undefined;
}

const KV_DEP_SECTION_REGEX = /(?:^|\.)(?:pypi-|build-|host-)?dependencies$/i;
const KV_DEP_REGEX = /^\s*(?:(["'])([^"']+)\1|([a-zA-Z0-9_\-\.]+))\s*=\s*(.*)$/;
const ARRAY_DEP_REGEX = /^\s*(["'])([a-zA-Z0-9_\-\.]+)(?:[><=~^!].*|\[.*\])?\1,?\s*(?:#.*)?$/;

function resolveManifestSectionScope(section: string, pkgKind?: string): { isPypi: boolean; featureName?: string } {
    const lowerSection = section.toLowerCase();
    const isPypi =
        pkgKind === 'pypi' ||
        lowerSection.includes('pypi') ||
        lowerSection === 'project' ||
        lowerSection.startsWith('project.optional-dependencies');
    const featureMatch =
        section.match(/^(?:tool\.pixi\.)?feature\.([^.]+)\./i) ||
        section.match(/^project\.optional-dependencies\.([^.]+)$/i);
    const isGlobalSection =
        /^(?:(?:tool\.pixi\.)?(?:target\.[^.]+\.)?(?:pypi-|build-|host-)?dependencies|project)$/i.test(section);
    const featureName = featureMatch ? featureMatch[1] : isGlobalSection ? 'default' : undefined;
    return { isPypi, featureName };
}

/**
 * Unified provider for manifest dependencies:
 * - InlayHintsProvider: shows locked versions inline (e.g. ': 1.26.4')
 * - HoverProvider: shows rich package metadata card with lock details
 * - DefinitionProvider: Ctrl+Click on package name navigates to pixi.lock
 */
export class PixiDependencyManifestProvider
    implements InlayHintsProvider, HoverProvider, DefinitionProvider, Disposable
{
    private readonly _onDidChangeInlayHints = new EventEmitter<void>();
    public readonly onDidChangeInlayHints: Event<void> = this._onDidChangeInlayHints.event;
    private readonly disposables: Disposable[] = [];

    constructor(
        private readonly projectManager: PixiProjectManager,
        pixiApi: PixiExtensionApi,
    ) {
        this.disposables.push(
            languages.registerInlayHintsProvider(MANIFEST_SELECTORS, this),
            languages.registerHoverProvider(MANIFEST_SELECTORS, this),
            languages.registerDefinitionProvider(MANIFEST_SELECTORS, this),
            this.projectManager.onDidChangeEnvironments(() => this.refresh()),
            pixiApi.onDidChangeActiveEnvironment(() => this.refresh()),
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pixi.dependencies.inlayHints')) {
                    this.refresh();
                }
            }),
            commands.registerCommand(
                'pixi.openLockfile',
                async (options?: { projectPath?: string; packageName?: string } | Uri) => {
                    await this.openLockfileCommand(options);
                },
            ),
        );
    }

    public refresh(): void {
        this._onDidChangeInlayHints.fire();
    }

    public dispose(): void {
        this._onDidChangeInlayHints.dispose();
        lockfileCache.clear();
        Disposable.from(...this.disposables).dispose();
    }

    public isInlayHintsEnabled(document: TextDocument): boolean {
        const config = workspace.getConfiguration('pixi.dependencies', document.uri);
        return config.get<boolean>('inlayHints', true);
    }

    /**
     * Parses all dependency entries from pixi.toml or pyproject.toml.
     */
    public parseManifestDependencies(document: TextDocument): ParsedDependency[] {
        const isPyprojectDoc = isPyproject(document);
        const lineCount = document.lineCount;
        let currentSection = '';
        let inArrayBlock = false;
        const deps: ParsedDependency[] = [];

        for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
            const rawLine = document.lineAt(lineIndex).text;
            const codeLine = rawLine
                .replace(/("(?:\\.|[^"\\])*"|'[^']*')|#.*$/g, (_, quoted) => quoted ?? '')
                .trimEnd();
            const trimmed = codeLine.trim();

            if (!trimmed) {
                continue;
            }

            const secMatch = trimmed.match(/^\[+([^\]]+)\]+$/);
            if (secMatch) {
                currentSection = secMatch[1].trim().replace(/["']/g, '');
                inArrayBlock = false;
                continue;
            }

            // PEP 621 array dependencies in pyproject.toml
            if (currentSection === 'project' || currentSection.startsWith('project.optional-dependencies')) {
                if (/=\s*\[/.test(trimmed)) {
                    inArrayBlock = true;
                    continue;
                }
            }

            if (inArrayBlock) {
                if (trimmed.includes(']')) {
                    inArrayBlock = false;
                }
                const arrMatch = trimmed.match(ARRAY_DEP_REGEX);
                if (arrMatch) {
                    const pkgName = arrMatch[2];
                    const nameStart = rawLine.indexOf(pkgName);
                    const nameEnd = nameStart + pkgName.length;
                    const nameRange = new Range(lineIndex, nameStart, lineIndex, nameEnd);
                    const valEnd = codeLine.length;
                    const valueRange = new Range(lineIndex, nameEnd, lineIndex, valEnd);
                    const insertPosition = new Position(lineIndex, valEnd);
                    const requestedSpec = trimmed.replace(/^["']|["'],?$/g, '').trim();

                    deps.push({
                        name: pkgName,
                        section: currentSection,
                        line: lineIndex,
                        nameRange,
                        valueRange,
                        insertPosition,
                        requestedSpec,
                    });
                }
                continue;
            }

            // Standard Pixi table dependencies
            if (isPixiManifestSection(currentSection, isPyprojectDoc) && KV_DEP_SECTION_REGEX.test(currentSection)) {
                const kvMatch = codeLine.match(KV_DEP_REGEX);
                if (kvMatch) {
                    const pkgName = kvMatch[2] || kvMatch[3];
                    const nameStart = rawLine.indexOf(pkgName);
                    const nameEnd = nameStart + pkgName.length;
                    const nameRange = new Range(lineIndex, nameStart, lineIndex, nameEnd);

                    const eqIndex = rawLine.indexOf('=');
                    const afterEq = rawLine.substring(eqIndex + 1);
                    const valStart = eqIndex + 1 + (afterEq.length - afterEq.trimStart().length);
                    const valEnd = codeLine.length;
                    const valueRange = new Range(lineIndex, valStart, lineIndex, valEnd);
                    const insertPosition = new Position(lineIndex, valEnd);
                    const rawVal = rawLine.substring(valStart, valEnd).trim();
                    let requestedSpec = rawVal.replace(/^["']|["']$/g, '').trim();
                    if (rawVal.startsWith('{')) {
                        const versionMatch = rawVal.match(/version\s*=\s*["']([^"']+)["']/);
                        requestedSpec = versionMatch ? versionMatch[1] : rawVal;
                    }

                    deps.push({
                        name: pkgName,
                        section: currentSection,
                        line: lineIndex,
                        nameRange,
                        valueRange,
                        insertPosition,
                        requestedSpec,
                    });
                }
            }
        }

        return deps;
    }

    private getDependencyAtPosition(document: TextDocument, position: Position): ParsedDependency | undefined {
        const deps = this.parseManifestDependencies(document);
        return deps.find(
            (d) =>
                d.line === position.line &&
                ((position.character >= d.nameRange.start.character &&
                    position.character <= d.nameRange.end.character) ||
                    (position.character >= d.valueRange.start.character &&
                        position.character <= d.valueRange.end.character)),
        );
    }

    /**
     * Provide InlayHints showing locked version inline at the end of each dependency line.
     */
    public async provideInlayHints(
        document: TextDocument,
        range: Range,
        token: CancellationToken,
    ): Promise<InlayHint[]> {
        if (!this.isInlayHintsEnabled(document)) {
            return [];
        }

        const projectPath = this.projectManager.findProjectForUri(document.uri);
        if (!projectPath) {
            return [];
        }

        const deps = this.parseManifestDependencies(document);
        if (deps.length === 0 || token.isCancellationRequested) {
            return [];
        }

        // Filter dependencies that fall within the requested range
        const visibleDeps = deps.filter((d) => d.line >= range.start.line && d.line <= range.end.line);
        if (visibleDeps.length === 0) {
            return [];
        }

        const activeEnv = this.projectManager.getEnvironmentForUri(document.uri);
        const activeEnvName = activeEnv?.pixiEnvName || 'default';
        const activePackages = await this.projectManager.getPackagesForEnvironment(activeEnvName, projectPath);
        if (token.isCancellationRequested) {
            return [];
        }

        const activeMap = this.createPackageMap(activePackages);
        const hints: InlayHint[] = [];
        const missingDeps: ParsedDependency[] = [];

        for (const dep of visibleDeps) {
            const pkg = activeMap.get(normalizePkgName(dep.name));
            if (pkg && pkg.version) {
                hints.push(this.createInlayHint(dep, pkg));
            } else {
                missingDeps.push(dep);
            }
        }

        // Fallback for dependencies not present in active environment (e.g. feature-specific dependencies)
        if (missingDeps.length > 0 && !token.isCancellationRequested) {
            // Fast in-memory path: check pixi.lock directly without spawning child processes
            const lockPath = getLockfilePath(projectPath);
            const lockLines = await getLockfileLines(lockPath);

            if (lockLines) {
                for (const dep of missingDeps) {
                    const lockedVer = getLockedVersionFromLines(lockLines, dep.name);
                    if (lockedVer) {
                        hints.push(this.createInlayHint(dep, { version: lockedVer } as PixiPackage));
                    }
                }
            }
        }

        return hints;
    }

    /**
     * Provide Hover card displaying locked version, build, channel, license, and multi-env differences.
     */
    public async provideHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
    ): Promise<Hover | undefined> {
        const projectPath = this.projectManager.findProjectForUri(document.uri);
        if (!projectPath) {
            return undefined;
        }

        const matched = this.getDependencyAtPosition(document, position);
        if (!matched || token.isCancellationRequested) {
            return undefined;
        }

        const activeEnv = this.projectManager.getEnvironmentForUri(document.uri);
        const activeEnvName = activeEnv?.pixiEnvName || 'default';
        const activePackages = await this.projectManager.getPackagesForEnvironment(activeEnvName, projectPath);
        if (token.isCancellationRequested) {
            return undefined;
        }

        const normMatchedName = normalizePkgName(matched.name);
        const activeMap = this.createPackageMap(activePackages);
        let targetPkg = activeMap.get(normMatchedName);
        let foundEnvName = activeEnvName;

        // Collect cross-environment occurrences
        const allEnvs = this.projectManager.getEnvironmentsForProject(projectPath);
        const envVersions = new Map<string, PixiPackage>();

        if (targetPkg) {
            envVersions.set(activeEnvName, targetPkg);
        }

        const otherEnvs = allEnvs.filter((e) => e.pixiEnvName !== activeEnvName && e.pixiStatus !== 'incompatible');
        if (otherEnvs.length > 0) {
            const otherResults = await Promise.all(
                otherEnvs.map(async (e) => ({
                    envName: e.pixiEnvName,
                    packages: await this.projectManager.getPackagesForEnvironment(e.pixiEnvName, projectPath),
                })),
            );

            if (token.isCancellationRequested) {
                return undefined;
            }

            for (const { envName, packages } of otherResults) {
                const map = this.createPackageMap(packages);
                const pkg = map.get(normMatchedName);
                if (pkg) {
                    envVersions.set(envName, pkg);
                    if (!targetPkg) {
                        targetPkg = pkg;
                        foundEnvName = envName;
                    }
                }
            }
        }

        const lockPath = getLockfilePath(projectPath);
        const lockExists = fs.existsSync(lockPath);
        const md = new MarkdownString();
        md.isTrusted = true;
        md.supportThemeIcons = true;

        const { isPypi, featureName: sectionFeatureName } = resolveManifestSectionScope(
            matched.section,
            targetPkg?.kind,
        );

        if (!targetPkg) {
            md.appendMarkdown(`### $(package) **${matched.name}**\n\n`);
            if (matched.requestedSpec) {
                md.appendMarkdown(`- **Requested Spec**: \`${matched.requestedSpec}\`\n`);
            }
            md.appendMarkdown(`- **Section**: \`${matched.section}\`\n\n`);
            if (!lockExists) {
                md.appendMarkdown(`*No lockfile (\`pixi.lock\`) found for this project.*\n\n`);
            } else {
                md.appendMarkdown(`*Not resolved in \`pixi.lock\` yet.*\n\n`);
            }
            const lockArg = encodeCommandArg(projectPath);
            const removeArg = encodeCommandArg({
                projectPath,
                pkg: { name: matched.name, kind: isPypi ? 'pypi' : 'conda' },
                env: { pixiEnvName: activeEnvName },
                featureName: sectionFeatureName,
            });
            const unresolvedActions = [
                `[$(lock) Run Pixi Lock](command:pixi.lock?${lockArg} "Update project lockfile")`,
                `[$(trash) Remove](command:pixi.removePackage?${removeArg} "Remove '${matched.name}' from manifest")`,
            ];
            md.appendMarkdown(`---\n${unresolvedActions.join(' &nbsp;&nbsp;|&nbsp;&nbsp; ')}`);
        } else {
            md.appendMarkdown(`### $(package) **${targetPkg.name}** \`${targetPkg.version}\`\n\n`);

            md.appendMarkdown(`| Detail | Value |\n`);
            md.appendMarkdown(`| :--- | :--- |\n`);
            md.appendMarkdown(`| **Locked Version** | \`${targetPkg.version}\` |\n`);
            md.appendMarkdown(`| **Kind** | \`${targetPkg.kind || 'conda'}\` |\n`);
            if (targetPkg.build) {
                md.appendMarkdown(`| **Build** | \`${targetPkg.build}\` |\n`);
            }
            const spec = matched.requestedSpec || targetPkg.requested_spec;
            if (spec) {
                md.appendMarkdown(`| **Requested Spec** | \`${spec}\` |\n`);
            }
            if (targetPkg.license) {
                md.appendMarkdown(`| **License** | \`${targetPkg.license}\` |\n`);
            }
            if (targetPkg.source) {
                md.appendMarkdown(`| **Source** | \`${targetPkg.source}\` |\n`);
            }
            if (targetPkg.is_local) {
                const localInfo = targetPkg.local_path
                    ? `${targetPkg.local_path} ${targetPkg.is_editable ? '(editable)' : ''}`
                    : targetPkg.is_editable
                      ? 'editable'
                      : 'local';
                md.appendMarkdown(`| **Local** | \`${localInfo}\` |\n`);
            }

            md.appendMarkdown(
                `\n**Environment**: \`${foundEnvName}\`${foundEnvName === activeEnvName ? ' (active)' : ''}\n\n`,
            );

            // Highlight differences across other environments if any
            if (envVersions.size > 1) {
                const diffVersions = Array.from(envVersions.entries()).filter(
                    ([env, p]) =>
                        env !== foundEnvName && (p.version !== targetPkg?.version || p.build !== targetPkg?.build),
                );
                if (diffVersions.length > 0) {
                    md.appendMarkdown(`**Other Environments:**\n`);
                    for (const [env, p] of diffVersions) {
                        const buildSuffix = p.build ? ` (\`${p.build}\`)` : '';
                        md.appendMarkdown(`- \`${env}\`: \`${p.version}\`${buildSuffix}\n`);
                    }
                    md.appendMarkdown(`\n`);
                }
            }

            const pkgActionArg = encodeCommandArg({
                projectPath,
                pkg: { name: targetPkg.name, kind: isPypi ? 'pypi' : 'conda' },
                env: { pixiEnvName: foundEnvName },
                featureName: sectionFeatureName,
            });
            const removeActionArg =
                targetPkg.name === matched.name
                    ? pkgActionArg
                    : encodeCommandArg({
                          projectPath,
                          pkg: { name: matched.name, kind: isPypi ? 'pypi' : 'conda' },
                          env: { pixiEnvName: foundEnvName },
                          featureName: sectionFeatureName,
                      });

            const isLocalOrEditable = Boolean(targetPkg.is_local || targetPkg.is_editable);
            const actions: string[] = [];
            if (!isLocalOrEditable) {
                actions.push(
                    `[$(arrow-up) Update](command:pixi.updatePackage?${pkgActionArg} "Update '${targetPkg.name}' in '${foundEnvName}'")`,
                );
            }
            actions.push(
                `[$(question) Why](command:pixi.whyPackage?${pkgActionArg} "Show why '${targetPkg.name}' is installed in '${foundEnvName}'")`,
                `[$(trash) Remove](command:pixi.removePackage?${removeActionArg} "Remove '${matched.name}' from manifest")`,
            );
            if (lockExists) {
                const openLockArgs = encodeCommandArg({ projectPath, packageName: matched.name });
                actions.push(
                    `[$(go-to-file) Open in pixi.lock](command:pixi.openLockfile?${openLockArgs} "Jump to package definition in pixi.lock")`,
                );
            }

            if (!isLocalOrEditable) {
                if (isPypi) {
                    const pypiUrl = getPypiPackageUrl(targetPkg.name);
                    actions.push(`[$(link-external) PyPI](${pypiUrl} "Open package on PyPI")`);
                } else {
                    const chMatch = targetPkg.source?.match(/conda\.anaconda\.org\/([^/]+)/);
                    const channel = chMatch ? chMatch[1] : DEFAULT_CONDA_CHANNEL;
                    const prefixUrl = getPrefixDevPackageUrl(channel, targetPkg.name);
                    actions.push(`[$(link-external) prefix.dev](${prefixUrl} "Open package on prefix.dev")`);
                }
            }

            md.appendMarkdown(`---\n${actions.join(' &nbsp;&nbsp;|&nbsp;&nbsp; ')}`);
        }

        const highlightRange = new Range(matched.nameRange.start, matched.valueRange.end);
        return new Hover(md, highlightRange);
    }

    /**
     * Provide Definition (Ctrl/Cmd + Click) to navigate directly to the package record in pixi.lock.
     */
    public async provideDefinition(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
    ): Promise<Definition | undefined> {
        const projectPath = this.projectManager.findProjectForUri(document.uri);
        if (!projectPath) {
            return undefined;
        }

        const matched = this.getDependencyAtPosition(document, position);
        if (!matched || token.isCancellationRequested) {
            return undefined;
        }

        const lockPath = getLockfilePath(projectPath);
        const lines = await getLockfileLines(lockPath);
        const targetLine = lines ? findPackageLineInLines(lines, matched.name) : -1;
        if (targetLine < 0 || token.isCancellationRequested) {
            return undefined;
        }

        return new Location(Uri.file(lockPath), new Position(targetLine, 0));
    }

    /**
     * Helper to open pixi.lock, optionally jumping directly to a package's line.
     */
    public async openLockfileCommand(options?: { projectPath?: string; packageName?: string } | Uri): Promise<void> {
        const packageName = options instanceof Uri ? undefined : options?.packageName;
        const projectPath = await pickPixiProject(this.projectManager, 'Select Pixi project to open lockfile', options);
        if (!projectPath) {
            return;
        }

        const lockPath = getLockfilePath(projectPath);
        if (!fs.existsSync(lockPath)) {
            window.showWarningMessage(`No ${LOCKFILE_NAME} found in ${projectPath}`);
            return;
        }

        try {
            const doc = await workspace.openTextDocument(Uri.file(lockPath));
            const editor = await window.showTextDocument(doc);

            if (packageName) {
                const lines = await getLockfileLines(lockPath);
                const targetLine = lines ? findPackageLineInLines(lines, packageName) : -1;
                if (targetLine >= 0) {
                    revealRangeInEditor(editor, targetLine, 0, 0);
                }
            }
        } catch (error) {
            window.showErrorMessage(
                `Failed to open lockfile: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private createPackageMap(packages: PixiPackage[]): Map<string, PixiPackage> {
        return new Map(packages.map((pkg) => [normalizePkgName(pkg.name), pkg]));
    }

    private createInlayHint(dep: ParsedDependency, pkg: PixiPackage): InlayHint {
        const tag = pkg.is_editable ? ' (editable)' : pkg.is_local ? ' (local)' : '';
        const hint = new InlayHint(dep.insertPosition, `: ${pkg.version}${tag}`, InlayHintKind.Type);
        hint.paddingLeft = true;
        hint.paddingRight = false;
        return hint;
    }
}
