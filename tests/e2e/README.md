# End-to-end harness

Drives the Requests page in a real Jellyfin with this repository's build of the plugin, the
released Seerr Proxy and JavaScript Injector, and a real Seerr, all in throwaway containers.

It checks that Requests appears in each display mode's navigation, that discovery, search,
details, requests, edits and cancels work, and that every request lands in Seerr as the user
who made it.

## Running

Needs Docker, the .NET 10 SDK, Node and internet access (Seerr reads TMDB).

```bash
cd tests/e2e
npm ci
npx playwright install chromium
npx playwright test
```

A run builds the plugin, starts Jellyfin and Seerr, creates three users and links two of them in
Seerr, then runs the tests and removes the containers. About a minute once the images are
cached.

| Variable | Effect |
| --- | --- |
| `HARNESS_KEEP=1` | leave the containers running and print their addresses |
| `JELLYFIN_IMAGE` | another Jellyfin image (default `jellyfin/jellyfin:12.4`) |
| `SEERR_IMAGE` | another Seerr image (default `ghcr.io/seerr-team/seerr:develop`) |
| `PROXY_DIR` | build Seerr Proxy from a checkout instead of using its release |
| `PROXY_ZIP_URL`, `INJECTOR_ZIP_URL` | other release archives |

The users are `alice` and `bob`, both linked in Seerr, and `carol`, who is not. Passwords are
`<name>-harness-pw`; the admin is `admin` / `harness-admin-pw`.

Downloads are cached in `.cache/` and the build goes to `.build/`, inside this folder rather than
the system temp folder: rootless Docker cannot see this process's `/tmp`.
