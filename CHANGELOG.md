# Changelog

All notable changes to the "pixi" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.0] - 2026-10-21

- **Workspace Overview & Monorepo Manifest Discovery**:
    - Add pinned Workspace Overview root card displaying rich project metadata, channels, environments, and platforms with click-to-open manifest navigation.
    - Implement recursive manifest watching (`**/{pixi.toml,pyproject.toml}`) with ignore-filtering (`.pixi`, `node_modules`, `.git`) to seamlessly track nested monorepo packages.
- **Targeted Cache Invalidation & Performance**:
    - Introduce granular cache invalidation for features, tasks, and outdated package inspections triggered selectively on manifest file edits, eliminating redundant CLI process overhead.
- **Semantic Task & Tooling Integration**:
    - Dynamically infer Codicon icons and markdown tooltips for tasks based on command semantics (`test`, `build`, `bench`, `lint`, `docs`, `clean`, `serve`, etc.).
    - Display global tool executable command aliases (e.g. `ripgrep (rg)`) and multi-binary counters in global tools view.
    - Streamline task inline execution actions and display task count badges in project tree headers.
- **System Requirements & UI Polish**:
    - Add human-readable labels, formatting, and rich documentation tooltips for system requirement properties (`linux-version`, `cuda`, `glibc`, `archspec`, `macos-version`).
    - Unify Codicon Markdown tooltips, badge typography, and muted styling across all 4 tree views and empty states.

## [2.2.1] - 2026-10-19

- **Python Environment Manager & Global Resolution**:
    - Deduplicate global environment change events via `syncEffectiveGlobalEnv` with diff tracking.
    - Accurately prioritize per-resource environment mappings and workspace folders before falling back to global defaults.
    - Clean up internal state on dispose to eliminate potential memory retention.
- **Extension Activation Concurrency & Startup Race Prevention**:
    - Concurrently launch `activatePythonSupport` and `projectManager.initialize` via `Promise.all` to accelerate extension startup.
    - Register Python environment manager early on tick 0, resolving startup race warnings with `vscode-python-envs`.
    - Coordinate project initialization with `initPromise` and `whenReady` in `PixiProjectManager`.
    - Guard `validatePixiCli` behind project count checks to eliminate false-positive CLI warnings in non-Pixi or empty workspaces.
- **Authentication Hub & Channel Decoupling**:
    - Expose unified `Pixi: Authentication ...` command in the Command Palette while keeping granular sub-commands hidden to prevent palette clutter.
    - Decouple global authentication credentials from project-scoped Conda channel management.
- **Code Quality & CI Compliance**:
    - Enforce Prettier formatting across manifests, documentation, and TypeScript sources to ensure green release pipelines.

## [2.2.0] - 2026-10-19

- **Dynamic View Actions & Grouping**:
    - Dynamically switch the primary action on the Environments view title bar (`+` button) between `Create Environment ...` and `Create Feature ...` according to the active grouping mode (`environment` vs `feature`).
    - Synchronize `pixi.environmentsViewMode` context key to provide instant menu state transitions when changing view groupings.
- **Terminal Environment Selection & Race Condition Protection**:
    - Add native Jupyter Notebook editor context awareness (`window.activeNotebookEditor`) for accurate terminal environment and project path resolution.
    - Implement a structured environment selection hierarchy prioritizing `pixi.terminal.defaultEnvironment` and active project environments over arbitrary installed environments.
    - Guard against asynchronous race conditions in terminal environment variable synchronization via sequential request tracking (`syncSeq`).
    - Listen for active notebook switching, configuration adjustments (`pixi.terminal.*`, `pixi.environmentRules`), and public active environment change events.
    - Highlight active project environments and refine multi-project labeling in quick picks.
- **Unified Feature & Environment Creation Workflows**:
    - Unify interactive package search and empty declaration options across both feature and environment creation commands.
    - Enhance initial package specification resolution with conda/pypi search and prompt options.
- **Jupyter Notebook & Python Kernel Synchronization**:
    - Implement atomic environment refresh and per-resource environment resolution.
    - Automatically synchronize Jupyter notebook active kernels when switching Pixi environments.
- **Release & Quality Assurance Automation**:
    - Enforce automated formatting, linting, and type checking in CI release pipelines prior to marketplace publication.

## [2.0.1] - 2026-10-19

- **Windows Path Sensitivity & Environment Management**:
    - Introduce canonical `PathMap` and `PathSet` collection types for case-insensitive lookup and case-preserving keys on Windows.
    - Fix an issue where refreshing or switching environments on Windows purged all environments from the tree view and active environment state due to path casing discrepancies (`folder.uri.fsPath`).
    - Resolve project path mapping in Python environment manager for Jupyter Notebooks (`.ipynb`) and document scopes.
    - Reinforce Jupyter notebook `ipykernel` detection and installation prompt flow.
- **Automatic Package Update Inspection**:
    - Add native background package update checking with inline manifest hints (`pixi.toml` / `pyproject.toml`) and visual upgrade indicators in the Environments view.
    - Support configurable check intervals and opt-in settings (`pixi.packageUpdates.enabled`, `pixi.packageUpdates.showInlineHints`).
- **Terminal & Configuration Customization**:
    - Add customizable terminal naming formats and flexible shell execution activation options.

## [2.0.0] - 2026-10-18

- **Modern Pixi Workspace Architecture & Baseline Compatibility**:
    - Set minimum Pixi version requirement to `>= 0.60.0` (covering all daily workflows: environments, tasks, packages, terminals, Python, and manifests), with `>= 0.79.0` recommended for complete modern workspace CLI feature access.
    - Completely remove legacy compatibility shims and workarounds for obsolete pre-0.60 Pixi releases.
    - Streamline Command Palette hierarchy: consolidate scattered commands into 15 high-level, focused Hub entries and hide internal sub-menus (`when: false`).
- **Pixi Solve Groups & Workspace Dependencies**:
    - Add native support for Pixi solve groups (`[environments.<name>.solve-group]`), enabling co-solved environments and visual solve group indicators in the Environments view.
    - Add first-class support for workspace-level shared dependencies (`[workspace.dependencies]`) via native `pixi workspace dependencies` CLI.
- **Unified Workspace Hub (`pixi.workspace`)**:
    - Centralized interactive menu to manage shared workspace dependencies, target platforms, channels, system requirements, lockfiles, version bumping, and descriptions.
    - Interactive target platform picker with 1-click host auto-detection for OS, architecture, and GPU CUDA virtual packages.
    - Interactive system requirements hub (`pixi.systemRequirements`) for CUDA, glibc, archspec, and OS platform constraints.
- **Unified Configuration & Authentication Hub (`pixi.config`)**:
    - Manage Pixi configuration across workspace local, user global, and system scopes (`pixi config list`, `set`, `unset`, `append`, `prepend`, `edit`).
    - Consolidate private registry credentials and authentication (`pixi auth`), including background OAuth device flow with zero terminal clutter.
- **Environment Import & Export**:
    - Import external Conda `environment.yml` and PyPI `requirements.txt` into existing or new environments (`pixi import`).
    - Export environment specifications to standard Conda environment YAML or Conda Explicit Specification (`@EXPLICIT`).
- **Granular Cleanup & Machine Registry Management (`pixi.clean`)**:
    - Targeted cleanup for project environments, individual environment prefixes, activation script cache (`pixi clean --activation-cache`), build backends, and package caches.
    - Machine-wide workspace registry management (`pixi workspace register`) and stale registry cleanup (`pixi clean --workspaces-registry`).
- **Task Execution Arguments Pipeline**:
    - Pass arbitrary runtime arguments (`ShellExecution`) to Pixi tasks from Command Palette (`pixi.runTaskWithArgs`), Tasks tree view, Hover, and CodeLens without argument loss.
    - Support declared task aliases in project manifests.
- **Terminal Execution & ShellHook Mode**:
    - Introduce `pixi.terminal.activationMode` supporting fast `shellHook` environment variable activation alongside `shell`.
    - Add configurable `pixi.executionMode` (`smart`, `terminal`, `notification`) for running tasks and package actions.
- **Package Management Enhancements**:
    - 1-click single package reinstall directly from the Environments tree view.
    - Selective package upgrades via interactive multi-select QuickPick in `Pixi: Update / Upgrade ...`.
    - Outdated package dry-run inspection with build diffs and cascade removal warnings.
- **Codebase Modernization & Performance**:
    - Eliminate indirect command reflection (`executeCommand('pixi....')`) in favor of direct handler functions.
    - Consolidate project path resolution, storage key normalization, and precompiled regexes.
    - Upgrade development toolchain to TypeScript 6, ESLint 10, and Prettier 3.8.

## [1.6.4] - 2026-10-13

- **Private Registry & Credentials Management (`pixi auth`)**:
    - Add native interactive authentication hub (`pixi.auth`), multi-protocol login wizard (`pixi.auth.login`), host logout (`pixi.auth.logout`), copy token (`pixi.auth.copyToken`), and credential status inspection (`pixi.auth.status`).
    - Implement native background OAuth device flow with automatic clipboard copy of device code and browser launch (0 terminal windows).
    - Upgrade Auth Storage in Pixi Info view to a hierarchical tree showing authenticated hosts, methods, and usernames with inline actions.
    - Sanitize sensitive credentials (tokens, passwords, secret keys) in CLI error logging.

## [1.6.3] - 2026-10-13

- **Local & Editable Package Action Safeguards**:
    - Hide inline update action and context menu item for local path and editable dependencies in the Environments tree view, and filter them out from interactive package update pickers.

## [1.6.2] - 2026-10-13

- **Unified Target Platform Picker (`pixi.platform`)**:
    - Consolidate platform addition and removal into a single interactive check/uncheck multi-select QuickPick (`Pixi: Platform ...`), displaying custom platforms and virtual packages alongside standard Conda presets.
- **Unified Feature & Environment Tree Views**:
    - Unify `PixiFeatureTreeItem` and `PixiPackageTreeItem` across both Environment and Feature view modes, resolving installed package metadata (versions, builds, licenses, local editable paths) and enabling full package context menu actions directly in Feature view.
- **Async Cache Unification & Codebase Simplification**:
    - Unify task, package, manifest schema, and Python environment caches into single in-flight `Promise` maps, reuse `PixiProjectTreeItem` across views, and remove redundant abstractions and menu guard rules.

## [1.6.1] - 2026-10-12

- **Target Platform Management (`pixi.platform`)**:
    - Introduce interactive `Pixi: Platform ...`, `Pixi: Add Platform ...`, and `Pixi: Remove Platform ...` commands supporting both workspace-global and feature-specific (`-f <feature>`) target platforms.
    - Support multi-select addition and removal of Conda target platforms (`linux-64`, `linux-aarch64`, `osx-arm64`, `osx-64`, `win-64`, `win-arm64`) with host OS detection and safety guards against removing all workspace platforms.
- **Feature-Scoped Channel Management & Multi-Select Removal**:
    - Extend `Pixi: Add Channel ...` and `Pixi: Remove Channel ...` to support feature-level channels (`pixi workspace channel add/remove -f <feature>`) and multi-select channel removal.
    - Register channel and platform management actions directly in feature tree node context menus.
- **Selective Package Upgrade (`pixi upgrade`)**:
    - Add an interactive multi-select package picker (all selected by default) to `Upgrade Dependencies` in `Pixi: Update / Upgrade ...`, enabling selective manifest constraint upgrades (`pixi upgrade <pkg...>`) alongside full workspace upgrades.
- **Manifest Hover Quick Actions**:
    - Add clickable action links (`Update`, `Why`, `Remove`, `Open in pixi.lock`, `Run Pixi Lock`) to dependency hover cards in `pixi.toml` and `pyproject.toml` with automatic feature scope detection.
    - Add `Run Task`, `Run in Environment...`, and `Remove` action links to task hover cards in manifest files.
- **Codebase Simplification & Refactoring**:
    - Extract shared workspace/feature scope resolution (`resolveWorkspaceOrFeatureScope`), scoped multi-item removal (`executeScopedWorkspaceRemove`), and environment picker helpers (`toEnvQuickPickItem`).
    - Eliminate redundant wrapper functions, duplicate parsing logic, and over-defensive checks across workspace commands, core discovery, tree views, and language providers.

## [1.6.0] - 2026-10-12

- **First-Class Feature Management & Dual-Perspective Environments View**:
    - Decouple Pixi features and environments across CLI parsing, manifest manipulation, and workspace commands.
    - Add dual-perspective grouping (`pixi.environments.viewMode`: `"environment"` vs `"feature"`) in the Environments tree view with a title-bar quick switcher.
    - Nest packages by defining feature under each environment node, providing clear visibility into feature composition (`features: [...]`) and solve groups.
    - Introduce interactive `Pixi: Manage Environments...` and `Pixi: Manage Features...` QuickPick command hubs for creating, editing, renaming, deleting, and jumping to manifest definitions of environments and features.
- **Streamlined Command Hierarchy & Package Picker Overhaul**:
    - Overhaul multi-step package search and selection with interactive `conda`/`pypi` source filters, target feature selection, and inline QuickInput action buttons.
    - Consolidate redundant environment and feature actions in the Command Palette and context menus for a cleaner user experience.
- **Tasks View Grouping & Prefix Enhancements**:
    - Expand `pixi.tasks.prefixSeparators` default delimiters to `["-", "_", ":", "::"]`.
    - Add `pixi.tasks.displayNameFormat` (`"stripped"` vs `"full"`) to control whether grouped task labels strip their prefix, updating the tree view instantaneously without re-querying the CLI.
    - Automatically infer existing group separators and preserve parent prefixes when creating tasks directly from a prefix group folder.
- **Architecture & Performance Optimizations**:
    - Extract shared provider utilities (`providerUtils`), TOML manipulation services (`tomlService`), and debounced manifest file watchers (`manifestWatcher`).
    - Parallelize workspace project discovery and refresh pipelines, and filter file watcher events strictly to Pixi-managed manifests.
    - Scope manifest completion, hover, inlay hint, and CodeLens providers strictly to valid Pixi manifests and fix inline TOML environment snippet formatting.

## [1.4.2] - 2026-10-07

- **Unified Dependency Update & Upgrade Workflows**:
    - Introduce an interactive `Pixi: Update / Upgrade ...` secondary menu with dry-run outdated package inspection, constraint-respecting lockfile updates, and manifest upgrade options.
    - Enhance dry-run QuickPick with pre-selected outdated items, build/version diff tracking, and cascade removal filtering.
    - Aggregate multi-environment package updates by name into single picker items, displaying affected environments and platforms cleanly in the detail line.
- **Inlay Hints & Hover Refinements**:
    - Filter outdated package inspection (`pixi update --dry-run`) strictly to explicit dependencies declared in the project manifest (`is_explicit === true`).
    - Streamline dependency inlay hints into clean passive annotations (e.g. `: 1.26.4`), eliminating duplicate hover tooltip cards and preserving full hover cards on package names.
- **Polymorphic Command Context & UI Polish**:
    - Centralize tree view, menu, and palette context extraction via `extractCommandContext`, improving support for multi-selection and editor title bar actions.
    - Provide intuitive Conda channel addition placement options (prepend with highest priority vs append).
    - Hide `pixi.init` from the Command Palette when a Pixi project is already present in the workspace.
- **Performance & Architectural Simplification**:
    - Optimize lockfile line search by eliminating redundant scans and using normalized canonical package keys.
    - Deduplicate task object instantiation in manifest task provider.
    - Flatten package spec parsing logic and unify regular expression escaping in task tree prefix grouping.

## [1.4.1] - 2026-10-05

- **Command Palette Streamlining & Submenu Architecture**:
    - Consolidate all environment and cache cleaning operations into a unified interactive `Pixi: Clean ...` secondary menu (clean project environments `.pixi`, clean specific environment on disk, clean global package cache).
    - Consolidate environment re-installation into an interactive `Pixi: Reinstall ...` secondary menu (reinstall all project environments vs reinstall a specific target environment).
    - Optimize global package cache cleaning to trigger immediately without prompting for project selection in multi-project workspaces.
    - Cleanse the Command Palette by suppressing 21 internal/tree-item-specific commands, title bar refresh icons, and duplicate entries (`when: false`).
- **Guard Conditions & Bug Fixes**:
    - Fix `pixi.init` visibility condition so project initialization remains accessible from the Command Palette even when a Pixi project is already present.
    - Add missing `pixi.hasPixiProject` guards to `pixi.openLockfile` and `pixi.createEnvironment`.
    - Standardize command title ellipsis (`...`) across interactive prompts (`Pixi: Run Task ...`, `Pixi: Clean ...`, `Pixi: Reinstall ...`).
    - Format and align `README.md` essential command table according to Prettier formatting rules.

## [1.4.0] - 2026-10-05

- **Jupyter Notebook Integration & Kernel Safeguards**:
    - Automatically detect if target Pixi environment contains `ipykernel` when selecting environments for Jupyter notebooks (`.ipynb`).
    - Provide interactive 1-click installation via Pixi (`pixi add -e <env> ipykernel`) or seamless switching to an alternative environment containing `ipykernel` to prevent runtime execution failures.
- **Task Execution Arguments Pipeline**:
    - Add runtime command-line arguments support (`args?: string[]`) across `PixiTask`, `PixiTaskDefinition`, and VS Code task runners.
    - Enable passing arbitrary execution arguments dynamically to `pixi.runTask` (`pixi run -e <env> <task> <args...>`).
    - Enhance manifest task parsing with environment alias fallbacks (`environment ?? default_environment`).
- **Architecture Simplification & Performance Refinement (KISS)**:
    - Streamline `persistentState` by eliminating asynchronous locks and normalizing synchronous state reads.
    - Proactive synchronous toolchain discovery with compiled regexes and file inspection.
    - Remove redundant directory-climbing heuristics in Python package management and unify environment sorting across the extension.
    - Extract reusable `pickInstallableEnvironment` helper to deduplicate selection logic across installation workflows.
- **Environment Lifecycle & Platform Compatibility**:
    - Refine environment deletion and cleaning workflows (`pixi.clean`, `pixi.reinstall`, `pixi.deleteEnvironment`) with granular choices (clean disk vs delete from manifest).
    - Decouple editor title bar actions from environment installation and gracefully skip incompatible platform queries.
- **Manifest Hover Theme Icon Rendering**:
    - Enable `supportThemeIcons` on dependency hover cards, rendering native VS Code Codicons (`$(package)`, `$(go-to-file)`, `$(lock)`, `$(link-external)`) instead of raw text placeholders.

## [1.2.2] - 2026-10-04

- **Offline Manifest Schema Validation & IntelliSense**:
    - Bundle official Pixi manifest JSON schema locally for 100% offline, zero-dependency autocompletion and hover documentation in `pixi.toml` and `pyproject.toml`.
    - Provide `pixi.manifest.schemaSupport` user configuration setting (default `true`) allowing seamless coexistence with third-party TOML language servers like Even Better TOML.
    - Intelligent quote and bracket replacement preventing duplicate closing brackets (`[workspace]]`) and double quotes (`""conda-forge""`).
    - Dedicated completions for top-level sections, subtask property tables (`[tasks.<name>]`), activation scripts/env, system requirements, PyPI options, and target platforms.
- **Native Package Search & Error Transparency**:
    - Propagate and display raw native error messages directly in the QuickPick UI when registry search encounters offline, network, or SSL errors, eliminating artificial wrappers.
    - Preserve direct manifest package addition (`$(edit) Add: "..."`) during registry search failures so offline users can add packages without interruptions.
    - Guard against accidental submission when selecting informational search banners.

## [1.2.1] - 2026-10-03

- **Windows Cache Measurement Performance**:
    - Accelerate cache directory size calculation on Windows using native `robocopy` read-only scan, reducing calculation time on 350k+ files from timeout failure to 1~2 seconds.
    - Add measurement fault tolerance to prevent repeated calculation attempts on inaccessible directories.
- **Task View Icons & Semantics Expansion**:
    - Expand semantic Codicon matching for tasks with deployment/release (`$(rocket)`), benchmark/evaluation (`$(pulse)`), preprocessing/ETL (`$(database)`), installation/download (`$(cloud-download)`), and monitoring (`$(eye)`).
    - Harmonize theme colors across all task icon categories.
- **Manifest Dependency Parsing & External Links**:
    - Support quoted platform/target dependency table headers in `pixi.toml` (e.g. `[target."linux-64".dependencies]`).
    - Support definition navigation to local path and editable subpackages in `pixi.lock`.
    - Add direct links to package documentation on PyPI and prefix.dev in package hover inspection cards.

## [1.2.0] - 2026-10-01

- **Locked Dependency Inlay Hints & Navigation**:
    - Inline locked version hints directly in `pixi.toml` and `pyproject.toml` manifests (e.g. `: 1.26.4`), configurable via `pixi.dependencies.inlayHints`.
    - Rich hover inspection cards displaying locked version, package kind (Conda/PyPI), build string, requested specification, license, and multi-environment matrix comparison.
    - `Ctrl`/`Cmd` + Click definition navigation from manifest package entries directly to corresponding definitions in `pixi.lock`.
    - Add `pixi.openLockfile` command to jump to and highlight package entries within `pixi.lock`.
- **Manifest Task CodeLens & Hover Actions**:
    - Interactive CodeLens and Hover actions for tasks in `pixi.toml` and `pyproject.toml` (`PixiTaskManifestProvider`).
    - Configurable display styles via `pixi.tasks.manifestActions` (`hover`, `compact`, `full`, `header`, `off`).
    - Direct manifest actions: Run Task, Run in Environment, and jump to Documentation.
- **Intelligent Tasks View Grouping & Management**:
    - Support namespace prefix grouping (`prefix`), environment grouping (`environment`), and flat listing (`none`) in the Tasks tree view, configurable via `pixi.tasks.groupBy`.
    - Quick switcher button in the Tasks view title bar to toggle grouping mode interactively.
    - Fine-grained grouping control with `pixi.tasks.prefixSeparators`, `pixi.tasks.minGroupSize`, and `pixi.tasks.maxDepth`.
    - Dedicated task lifecycle commands: `pixi.tasks.runTask`, `pixi.tasks.runTaskInEnvironment`, `pixi.tasks.removeTask`, and interactive task creation.
- **CI & Release Automation**:
    - Automate odd-minor pre-releases via GitHub Actions manual workflow dispatch.
    - Enforce even-minor versioning policy for stable releases according to VS Code marketplace guidelines.

## [1.0.1] - 2026-09-30

- **Fix Environment Platform Compatibility Check**:
    - Prioritize disk existence (`fs.existsSync`) to ensure installed environments are never mistakenly flagged as `(incompatible)`.
    - Match platform `subdir` and `name` against host platform, properly supporting custom named platforms (e.g. `win-64-cuda`, `linux-64-cuda`).
    - Expand `PixiEnvironmentPlatform` with `virtual_packages` and `PixiRawEnvironmentInfo` with `resolved_platform` matching native Pixi CLI schema.

## [1.0.0] - 2026-09-30

- **Dedicated Pixi Explorer Side Panel**: Introduced a full-featured Activity Bar container with 4 dedicated Tree Views:
    - `Environments`: Deep inspection of installed/uninstalled/incompatible environments, explicit vs transitive package dependencies, 1-click package updates/removal, and terminal launch.
    - `Tasks`: Interactive tree of declared Pixi tasks with 1-click run, execution in specific environments, and manifest definition jumping.
    - `Global Tools`: Visual management of user-level CLI packages installed in `~/.pixi/bin`, supporting inspection, sync, update, and uninstall.
    - `Pixi Info`: System diagnostics, Pixi CLI version, virtual packages, config files, disk cache size measurement, and 1-click cache cleaning.
- **Aggregated Package Search & Discovery**: High-performance real-time search across Conda repositories (`conda-forge`, etc.) and PyPI with instant version, platform, and license inspection, direct prefix.dev navigation, and reverse dependency diagnosis (`pixi.whyPackage`).
- **Polyglot Toolchain Scanner**: Automatic multi-language toolchain scanning (`src/core/toolchains.ts`) detecting Python, C/C++ compilers (GCC, Clang, MSVC, CMake, Ninja, headers), R (`R`, `Rscript`), and Rust (`rustc`, `cargo`).
- **Major Architectural Decoupling**: Cleanly separated language-agnostic Pixi Core (`src/core/`) from language adapters (`src/languages/`), providing a resilient polyglot foundation for Visual Studio Code and Open VSX.
- **Official Paxton Mascot & Visual Branding**: Adopted the official Pixi fairy mascot Paxton with dark-mode drop shadow as the extension icon, custom activity bar icon, and dark marketplace gallery banner.
- **Public Extension API**: Exported `PixiExtensionApi` (`sheeptao.pixi` exports) allowing third-party extensions to query Pixi projects, environments, toolchains, and packages, with bi-directional environment switching and change event subscriptions.
- **Manifest Lifecycle & Editor Navigation**: One-click action buttons in the editor title bar for `pixi.toml` and `pyproject.toml` (Lock, Install, Update, Reinstall).
- **Native Tasks & Terminal Profiles**: Automatic registration of Pixi tasks as native VS Code Tasks (`Terminal: Run Task...`) and pre-activated interactive Pixi terminal profiles.
- **Streamlined Documentation**: Comprehensive, visual, and minimalist documentation in `README.md`.
