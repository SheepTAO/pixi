# Release Process

This document describes the automated dual-marketplace release workflow for **Pixi for Visual Studio Code**.

## Pre-release

Pre-release versions can be manually triggered at any time using GitHub Actions:

1. Navigate to the **Actions** tab in GitHub and select the **CI** workflow.
2. Click **Run workflow** (`workflow_dispatch`) on the `main` branch.
3. The pipeline runs code quality checks and automatically packages and publishes a timestamped pre-release (`${MAJOR_MINOR}.<timestamp>`) to both:
    - [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi)
    - [Open VSX Registry](https://open-vsx.org/extension/sheeptao/pixi)

Users who opt in to Pre-release versions in VS Code will receive these updates automatically.

## Stable Release

Follow these steps to publish an official stable release:

1. **Verify repository secrets**:
   Ensure the following secrets are configured in GitHub repository settings (**Settings** → **Secrets and variables** → **Actions**):
    - `MARKETPLACE_TOKEN`: Visual Studio Marketplace Personal Access Token (PAT).
    - `OPENVSX_TOKEN`: Open VSX Personal Access Token.

2. **Update version and changelog**:
    - Update `"version"` in `package.json` (following Semantic Versioning, e.g. `1.0.0`).
    - Run `npm install` to synchronize `package-lock.json`.
    - Update `CHANGELOG.md` with release notes and highlights.

3. **Verify tests and packaging locally**:

    ```bash
    npm test
    npm run package-vsix   # Outputs .vsix package to dist/
    ```

4. **Commit and push changes**:

    ```bash
    git commit -am "chore(release): bump version to 1.0.0"
    git push origin main
    ```

5. **Create and push the Git tag**:

    ```bash
    git tag v1.0.0
    git push origin v1.0.0
    ```

6. **Monitor GitHub Actions**:
    - The release workflow (`.github/workflows/release.yaml`) triggers on `v*` tags.
    - It validates that the Git tag version matches `package.json`.
    - It publishes stable packages to VS Code Marketplace and Open VSX.
    - It generates a GitHub Release and attaches the compiled `.vsix` artifact.
