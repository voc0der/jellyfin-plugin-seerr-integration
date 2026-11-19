# Design

## Responsibilities

```text
Jellyfin            provides the identity: the signed-in user and their session
Seerr Proxy         turns that identity into the linked Seerr user and makes the call
Seerr Integration   draws the page and the interactions, nothing else
```

This plugin holds no Seerr credential, stores no user mapping, and has no endpoint that talks
to Seerr. Its server side does three things: keeps a small loader registered with JavaScript
Injector, serves the page's script, and reports its own state to the settings page.

## Identity

The page is identity-blind. These are requirements, not preferences:

```text
- every Seerr call goes to /Plugins/SeerrProxy/api/v1/** and nowhere else
- calls carry the user's own Jellyfin authorization, exactly as Jellyfin Web sends it
- no call carries a user id, a requester, or an identity header (X-API-User, X-Api-Key)
- no request body has userId, user, requestedBy or modifiedBy
- the GET request list is never filtered by requestedBy
- nothing falls back to another account when the user is unlinked or signed out
```

`createApi` in `Web/seerr-integration.js` is the only code that makes a request. It builds the
`Authorization` header with `ApiClient.setRequestHeaders`, the same call Jellyfin Web uses for
its own requests, and falls back to `MediaBrowser Token="..."` with the current access token.
It uses plain `fetch` rather than `ApiClient.ajax`, so a Seerr refusal never reaches Jellyfin
Web's request-failure handling. That matters because Seerr answers a refused delete with 401,
and the proxy passes Seerr's 4xx statuses through.

What the page learns from `auth/me` (the Seerr user id and permission bits) decides which
buttons it shows: a Cancel button on the user's own pending request, a 4K button for a user who
may request 4K. Seerr Proxy and Seerr enforce every permission regardless. A user who can see
other users' requests in Seerr (`MANAGE_REQUESTS` or `REQUEST_VIEW`) gets the list Seerr returns
for them, labelled Requests rather than My requests, with each requester named.

`auth/me` is also the gate. The proxy fails it with a precise reason for each state the page
must explain, and the page maps them in `describeError`:

| Proxy answer | Meaning | Page shows |
| --- | --- | --- |
| 404 with no JSON, or `PluginInactive` | Seerr Proxy missing or disabled | Requests are unavailable |
| 403 `PluginDisabled` | proxy switched off in its settings | Requests are switched off |
| 503 `PluginNotConfigured` | no Seerr URL or key | Requests are not set up |
| 404 `SeerrUserNotLinked` | user not imported in Seerr | Your account is not linked |
| 401 `MissingJellyfinUser` | session ended or not a user | Signed out |
| 502 `SeerrUnreachable` | Seerr down | Seerr is unreachable, with a retry |

The end-to-end harness proves the rule where it counts: requests made by alice and bob land in
Seerr with `requestedBy` set to each of them, each sees only their own list, an unlinked user
gets the message with nothing requested, and the browser never calls Seerr or sends an
identity field.

## Getting the page into Jellyfin Web

A plugin cannot add a user-facing page to Jellyfin Web by itself. `IHasWebPages` pages, even with
`EnableInMainMenu`, live in the admin dashboard. The page is therefore loaded by script.

### Why JavaScript Injector

[JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) is what this
plugin suite already uses for browser code (Transcode Guard's browser install warning), and the
bridge in `Browser/` is lifted from there. Since 4.0 the injector adds its loader to Jellyfin
Web's `index.html` at request time through an `IStartupFilter`. Nothing is written to disk,
no bundle is patched, and the same build serves Jellyfin 10.11 and 12.

This plugin registers one small ES5 loader (`Browser/bootstrap.js`) as a script that requires
authentication. The loader adds a script tag for
`Plugins/SeerrIntegration/Client/seerr-integration.js?v=<plugin version>`, built with
`ApiClient.getUrl` so a base URL is honoured. The page's code is therefore its own file: it can
use ES2015, a syntax error cannot break other plugins' scripts, and an upgrade replaces it
without touching the injector's configuration. The URL carries the version, so it is cached for
good and changes with each release.

The injector keeps plugin scripts in its own configuration and never prunes them, so the plugin
unregisters its loader when it is uninstalled, and the loader fails quietly if the script cannot
be loaded. The asset endpoint applies Seerr Proxy's kill switch: it serves nothing unless the
plugin's status is exactly `Active`.

### Why not Plugin Pages

[Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) 3.x was the first choice
in the original brief, and was checked against Jellyfin 12.4 before anything was built:

- It depends on File Transformation and regex-patches Jellyfin Web's main and runtime webpack
  bundles to add its route, including a hard-coded chunk id (`8372:"home-html"`). That is
  modifying Jellyfin Web's bundles, and it is why each release supports exactly one Jellyfin
  version.
- In the legacy drawer its entries land under a "Plugin Settings" heading at the bottom.
- In the default (Modern) display mode its entries go into the avatar menu, after Settings, or
  into the legacy drawer, which that mode does not show. Neither is a navigation entry.

## Navigation in Jellyfin 12

Measured on 12.4 with a non-admin user. The display modes are Auto (the Modern React app, the
default), Desktop (Legacy), Mobile (Legacy) and TV.

| Display mode | Navigation | Requests entry |
| --- | --- | --- |
| Auto, wide screen | app bar links: Favorites, then libraries. No side menu | app bar link after Favorites |
| Auto, narrow screen | Open Menu button opens a Material UI drawer: Home, Favorites, Libraries | drawer item after Favorites |
| Desktop, Mobile (Legacy) | `.mainDrawer`: Home, custom links, Media, User | right after Home, where Jellyfin puts its own custom menu links |
| TV | `.mainDrawer`, but its button is hidden | the same drawer entry, not reachable |

The Modern entries are clones of the Favorites link, so they carry the same Material UI classes
and follow the theme exactly. Clones have none of React's handlers, so the phone menu entry
closes the drawer by clicking its backdrop, as Plugin Pages does for its menu. A
`MutationObserver`, coalesced to one check per frame, puts an entry back whenever Jellyfin Web
re-renders its navigation.

## The page

The page owns `#/requests`. Its views are query parameters on that one path
(`view=movie&id=27205`, `view=search&q=...`, `view=requests&filter=pending`), so every view is a
real history entry and can be bookmarked.

Jellyfin Web's router renders its not-found page (`#fallbackPage`) for any route it does not
know. While `#/requests` is active the page adds a class to `<html>` that hides every other
`.mainAnimatedPage`, and shows its own `#seerrIntegrationPage`, which sits with Jellyfin's pages
in `.mainAnimatedPages`. It carries `page libraryPage mainAnimatedPage`, the classes the
not-found page uses, so it gets the same header spacing in every layout. It is deliberately
not `type-interior`: the legacy header treats that class as a dashboard page and swaps the
drawer for the admin menu.

On showing, the page raises `pagebeforeshow` and `pageshow`, the events Jellyfin Web's pages
raise. The legacy header answers them by clearing the previous page's section tabs and showing
the page's `data-title` and back button. The not-found page raises the same events when it
mounts, which can land later, so the page raises them again after any other page's `pageshow`
while its route is still active. In the Modern layout nothing listens.

Jellyfin Web navigates with `pushState`, which fires no event. Every navigation renders a page,
so the same per-frame observer notices when the hash has moved off `#/requests` and hides the
page. `hashchange`, `popstate` and Jellyfin's `viewshow` are handled too.

## Styling

Posters use Jellyfin's own card markup (`card`, `overflowPortraitCard`, `cardImageContainer`,
`cardText`), section titles use `sectionTitle`, and rows use `itemsContainer scrollX
hiddenScrollX`. All of these are in Jellyfin Web's always-loaded stylesheet, checked on 12.4,
so they look native even when `#/requests` is the first page opened.

Everything else is scoped to `#seerrIntegrationPage` and the `.sui-` dialogs, and coloured with
the Material UI variables Jellyfin's themes are written in (`--jf-palette-primary-main`,
`--jf-palette-text-secondary`, `--jf-palette-background-paper` and so on), with the dark theme's
values as fallbacks. Status colours (available, requested, pending, failed) are fixed, as in
Seerr. No rule touches Jellyfin's own elements except hiding its pages while `#/requests` is
active.

Posters and backdrops load from `image.tmdb.org`, as Seerr's own UI does when its image cache is
off. The browser never reaches Seerr itself.

## Seerr calls

| Call | Used for |
| --- | --- |
| `GET auth/me` | the gate, the user's id and permissions |
| `GET settings/public` | 4K switches, partial requests, specials, Seerr's hide-available settings |
| `GET discover/trending`, `discover/movies`, `discover/tv`, `discover/movies/upcoming`, `discover/tv/upcoming` | discover rows, up to five pages each as the row is scrolled |
| `GET search` | search |
| `GET movie/{id}`, `tv/{id}` | details, and titles and posters in the request list |
| `GET movie/{id}/recommendations`, `tv/{id}/recommendations` | More like this |
| `GET request` | the request list, ten at a time |
| `POST request` | a new request |
| `PUT request/{id}` | changing the seasons of a pending series request |
| `DELETE request/{id}` | cancelling a pending request |

Download progress needs no call of its own. Seerr attaches `downloadStatus` and
`downloadStatus4k`, its view of the Radarr and Sonarr queues, to every media record it returns,
so details and the request list read it from what they already fetched. Episodes in flight are
summed into one figure. The page offers a Refresh button beside the bar instead of polling.

The line under a title's status says whose request holds it: the user's own, or someone else's.
Other users' names appear only for users Seerr itself lets see other users' requests. When the
user's own request is approved, the line says why there is no Cancel: Seerr lets only a manager
withdraw an approved request.

All of these are on Seerr Proxy's allowlist. Not offered, because the allowlist does not carry
them and they are Seerr administration: approving and declining, retrying failed requests,
choosing a server, profile or folder (advanced requests), issues, quotas and the watchlist.

Seerr Proxy limits each user to 120 calls a minute. Details are cached for two minutes, discover
pages for five, and the session for five; the request list fetches titles three at a time from
that cache. Any request, edit or cancel clears the affected title and every discover page, so
badges never show a stale state. There is no polling: views refresh when they are opened and
after each action.

## Compatibility

The page is ES2015 without async functions, optional chaining or object spread, so it runs in
older Android WebViews. It is served on its own, so a browser that cannot parse it loses only
the Requests page. The JavaScript Injector loader is ES5, because the injector serves every
plugin's script as one file.

## Testing

```text
tests/Jellyfin.Plugin.SeerrIntegration.Tests   xUnit: the injector bridge, registration, the asset endpoint
tests/web                                      node:test: permissions, request states, routes, the proxy client
tests/e2e                                      Playwright: Jellyfin 12.4, Seerr Proxy, JavaScript Injector, real Seerr
```

The end-to-end harness installs the released Seerr Proxy and JavaScript Injector next to this
repository's build and links a real Seerr the way an admin would. See
[tests/e2e/README.md](../tests/e2e/README.md).
