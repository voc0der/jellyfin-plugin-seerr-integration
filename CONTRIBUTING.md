# Contributing to *jellyfin-plugin-seerr-integration*

Issues and pull requests are welcome!

## Getting Started

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Submit a pull request

## Building

```bash
dotnet build --configuration Release
```

The Requests page is `Web/seerr-integration.js` and the JavaScript Injector loader is
`Browser/bootstrap.js`. Both are embedded in the DLL, so a change to either needs a rebuild to
reach a server. There is no JavaScript build step.

## Testing

Three layers, all run by CI. The C# tests live outside the plugin project's directory so that
`dotnet build` at the repository root still resolves to the plugin alone, so give them an
explicit path:

```bash
dotnet test tests/Jellyfin.Plugin.SeerrIntegration.Tests --configuration Release
node --test tests/web/
```

`tests/web` loads the page script into a sandbox and checks its model and proxy client:
permissions, request and season states, routes, and that no call carries an identity. It needs
nothing but Node.

`tests/e2e` drives the page in a real Jellyfin with Seerr Proxy, JavaScript Injector and a real
Seerr. It is the only test of where navigation lands, of the page inside Jellyfin Web, and of who
Seerr records as the requester. Run it after any change under `Web/`, `Browser/` or `Api/`; see
[tests/e2e/README.md](tests/e2e/README.md). CI runs it for those paths too.

The rules in [docs/DESIGN.md](docs/DESIGN.md#identity) are requirements. A change that breaks one
of them is a bug even if every test passes.

## Coverage

The coverage badge in the README is a **manually updated** number, measured the same way as
[`jellyfin-plugin-seerr-proxy`](https://github.com/voc0der/jellyfin-plugin-seerr-proxy): coverlet's
overall line rate of a Release test run, with no exclusions. It covers the C# only. Refresh it in
the same commit as any change that moves it meaningfully.

```bash
dotnet test tests/Jellyfin.Plugin.SeerrIntegration.Tests \
  --configuration Release \
  --collect:"XPlat Code Coverage" \
  --results-directory /tmp/seerr-integration-coverage
```

The badge number is the top-level `line-rate` attribute of the `coverage.cobertura.xml` written
under that directory, as a percentage, rounded to the nearest whole number:

```bash
python3 - <<'EOF'
import glob, xml.etree.ElementTree as ET
report = glob.glob("/tmp/seerr-integration-coverage/**/coverage.cobertura.xml", recursive=True)[0]
root = ET.parse(report).getroot()
rate = float(root.get("line-rate")) * 100
print("line-rate %.2f%% (%s/%s lines) -> badge %d%%" % (
    rate, root.get("lines-covered"), root.get("lines-valid"), round(rate)))
EOF
```

Badge colours: `brightgreen` at or above 95, `green` under 95, `yellowgreen` under 85, `yellow`
under 75, `orange` under 60.

## Plugin GUID Safety

Before the first release, and any time plugin metadata changes, verify that the plugin GUID is
consistent and not already used by a known catalog:

```bash
bash scripts/verify-plugin-guid.sh
CHECK_REMOTE_GUIDS=1 bash scripts/verify-plugin-guid.sh
```

Do not copy GUIDs from Jellyfin's plugin template or from another plugin repository.

## Linting

Run lint checks locally before opening a PR:

```bash
dotnet format whitespace --verify-no-changes
dotnet format style --verify-no-changes --severity warn
dotnet format tests/Jellyfin.Plugin.SeerrIntegration.Tests/Jellyfin.Plugin.SeerrIntegration.Tests.csproj whitespace --verify-no-changes
dotnet format tests/Jellyfin.Plugin.SeerrIntegration.Tests/Jellyfin.Plugin.SeerrIntegration.Tests.csproj style --verify-no-changes --severity warn
node --check Web/seerr-integration.js
```

## Reporting Issues

- Search existing issues before opening a new one
- Include the Jellyfin version, the display mode (Settings -> Display), and the browser or app
- Include the Seerr Proxy and JavaScript Injector versions, and whether the user is linked in Seerr
- The settings page's status lines and any browser console errors mentioning Seerr Integration help

## Rules

- Keep branches, commits, and PRs focused. Do not mix unrelated local changes into the same PR.
- Use semantic names by default.

## Naming

- Branches: `fix/<scope>-<summary>`, `feat/<scope>-<summary>`, `refactor/<scope>-<summary>`
- Commits: `fix(scope): summary`, `feat(scope): summary`, `refactor(scope): summary`
- PR titles: `fix(scope): summary`, `feat(scope): summary`, `refactor(scope): summary`

## Pull Requests

- Keep changes focused and minimal
- Test against a running Jellyfin instance before submitting
- Describe what your PR changes and why
- Merging to `main` does not publish anything by itself. Add the `release` label before merging to cut a new tag and release; unlabelled changes go out with the next labelled merge

## Release Metadata

- `manifest.json` is updated by the release workflow when a new version is published.

## LLM Disclosure

This project uses LLM-assisted development. Contributions generated with AI assistance are
welcome, but please review and test all code before submitting.
