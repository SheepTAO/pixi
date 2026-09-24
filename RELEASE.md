# Release Process

This document describes the automated dual-marketplace release workflow for **Pixi for Visual Studio Code**.

## Pre-release

Every push or merge to the `main` branch automatically triggers the CI/CD pipeline to publish a pre-release version to both:

- [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi)
- [Open VSX Registry](https://open-vsx.org/extension/sheeptao/pixi)

Users who opt in to Pre-release versions in VS Code will receive these updates automatically.

## Stable Release

Follow these steps to publish an official stable release:

1. **Update version and changelog**:
    - Update `"version"` in `package.json` (following Semantic Versioning, e.g. `1.0.0`).
    - Run `npm install` to synchronize `package-lock.json`.
    - Update `CHANGELOG.md` with release notes and highlights.

2. **Verify tests and packaging locally**:

    ```bash
    npm test
    npm run package-vsix --no-dependencies   # Outputs to dist/
    ```

3. **Commit and merge changes**:
   Commit and merge the version bump to `main`:

    ```bash
    git commit -am "chore(release): bump version to x.y.z"
    git push origin main
    ```

4. **Create and push the Git tag**:

    ```bash
    git tag vx.y.z
    git push origin vx.y.z
    ```

5. **Monitor GitHub Actions**:
    - The release workflow (`.github/workflows/release.yaml`) triggers on `v*` tags.
    - It validates version match, publishes stable packages to VS Code Marketplace and Open VSX, and attaches the packaged `.vsix` artifact to a newly created GitHub Release.
