/*
 * Seerr Integration: the Requests page for Jellyfin Web.
 *
 * Loaded by the plugin's JavaScript Injector loader once a user is signed in. It adds a
 * Requests entry wherever the current display mode navigates (the legacy drawer, or the
 * Modern app bar and its phone menu), and draws the page itself on the #/requests route.
 *
 * Identity: every Seerr call goes to Seerr Proxy with the signed-in user's own Jellyfin
 * authorization, and the proxy decides which Seerr account acts. This file never sends a
 * user id, a requester, or an identity header, and never talks to Seerr directly. What it
 * learns about the user from auth/me only decides which buttons to show; Seerr Proxy and
 * Seerr enforce every permission.
 *
 * Syntax stays at ES2015 (no async/await, optional chaining or object spread) so the page
 * also runs in older Android WebViews. It is served as its own file, so nothing here can
 * break the scripts other plugins register.
 */
(function () {
    'use strict';

    if (window.SeerrIntegration) {
        return;
    }

    const VERSION = readVersion();
    const ROUTE = '/requests';
    const PAGE_ID = 'seerrIntegrationPage';
    const NAV_ATTR = 'data-seerr-integration-nav';
    const ACTIVE_CLASS = 'seerr-integration-active';
    const PROXY_PATH = 'Plugins/SeerrProxy/';
    const TMDB_IMAGES = 'https://image.tmdb.org/t/p/';
    const REQUESTS_PAGE_SIZE = 10;
    const DETAIL_TTL_MS = 2 * 60 * 1000;
    const DISCOVER_TTL_MS = 5 * 60 * 1000;
    const SESSION_TTL_MS = 5 * 60 * 1000;
    const ADD_TO_QUEUE_PATH = 'M21 3H3c-1.11 0-2 .89-2 2v12c0 1.1.89 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.11-.9-2-2-2zm0 14H3V5h18v12zm-5-7v2h-3v3h-2v-3H8v-2h3V7h2v3h3z';

    function readVersion() {
        const script = document.currentScript;
        const match = script && /[?&]v=([^&#]+)/.exec(script.src || '');
        return match ? decodeURIComponent(match[1]) : 'dev';
    }

    // ---------------------------------------------------------------------------------
    // Seerr model. Pure functions, unit tested in tests/web.
    // ---------------------------------------------------------------------------------

    // Mirrors seerr-team/seerr server/lib/permissions.ts.
    const Permission = {
        NONE: 0,
        ADMIN: 2,
        MANAGE_SETTINGS: 4,
        MANAGE_USERS: 8,
        MANAGE_REQUESTS: 16,
        REQUEST: 32,
        VOTE: 64,
        AUTO_APPROVE: 128,
        AUTO_APPROVE_MOVIE: 256,
        AUTO_APPROVE_TV: 512,
        REQUEST_4K: 1024,
        REQUEST_4K_MOVIE: 2048,
        REQUEST_4K_TV: 4096,
        REQUEST_ADVANCED: 8192,
        REQUEST_VIEW: 16384,
        AUTO_APPROVE_4K: 32768,
        AUTO_APPROVE_4K_MOVIE: 65536,
        AUTO_APPROVE_4K_TV: 131072,
        REQUEST_MOVIE: 262144,
        REQUEST_TV: 524288
    };

    // Mirrors server/constants/media.ts.
    const MediaStatus = {
        UNKNOWN: 1,
        PENDING: 2,
        PROCESSING: 3,
        PARTIALLY_AVAILABLE: 4,
        AVAILABLE: 5,
        BLOCKLISTED: 6,
        DELETED: 7
    };

    const RequestStatus = {
        PENDING: 1,
        APPROVED: 2,
        DECLINED: 3,
        FAILED: 4,
        COMPLETED: 5
    };

    // Seerr's own hasPermission: an admin holds everything, a list is all-of by default.
    function hasPermission(userPermissions, required, type) {
        const value = Number(userPermissions) || 0;
        if (required === Permission.NONE) {
            return true;
        }

        if (value & Permission.ADMIN) {
            return true;
        }

        const list = Array.isArray(required) ? required : [required];
        return type === 'or'
            ? list.some(function (permission) { return (value & permission) !== 0; })
            : list.every(function (permission) { return (value & permission) !== 0; });
    }

    function permissionsOf(me) {
        return me && typeof me.permissions === 'number' ? me.permissions : 0;
    }

    function canRequest(me, mediaType, is4k) {
        const permissions = permissionsOf(me);
        if (is4k) {
            return hasPermission(permissions, [Permission.REQUEST_4K, mediaType === 'movie' ? Permission.REQUEST_4K_MOVIE : Permission.REQUEST_4K_TV], 'or');
        }

        return hasPermission(permissions, [Permission.REQUEST, mediaType === 'movie' ? Permission.REQUEST_MOVIE : Permission.REQUEST_TV], 'or');
    }

    function is4kEnabled(settings, mediaType) {
        return !!(settings && (mediaType === 'movie' ? settings.movie4kEnabled : settings.series4kEnabled));
    }

    function canManageRequests(me) {
        return hasPermission(permissionsOf(me), Permission.MANAGE_REQUESTS);
    }

    // Seerr shows a user only their own requests unless they hold one of these.
    function seesOtherUsersRequests(me) {
        return hasPermission(permissionsOf(me), [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW], 'or');
    }

    function isOwnRequest(me, request) {
        return !!(me && request && request.requestedBy && request.requestedBy.id === me.id);
    }

    // Seerr deletes a request for its owner only while it is pending; a manager may always.
    function canCancelRequest(me, request) {
        return !!request && request.status === RequestStatus.PENDING && (isOwnRequest(me, request) || canManageRequests(me));
    }

    // Seerr lets an owner change the seasons of a pending series request. Changing a movie
    // request needs server and profile choices this page does not offer.
    function canEditRequest(me, request) {
        return canCancelRequest(me, request) && request.type === 'tv';
    }

    function mediaStatusOf(mediaInfo, is4k) {
        if (!mediaInfo) {
            return MediaStatus.UNKNOWN;
        }

        return (is4k ? mediaInfo.status4k : mediaInfo.status) || MediaStatus.UNKNOWN;
    }

    // The small poster badge. Unknown and deleted media carry none.
    function badgeFor(mediaInfo) {
        switch (mediaStatusOf(mediaInfo, false)) {
            case MediaStatus.AVAILABLE:
                return { kind: 'available', icon: 'check', label: 'Available' };
            case MediaStatus.PARTIALLY_AVAILABLE:
                return { kind: 'partial', icon: 'remove', label: 'Partially available' };
            case MediaStatus.PROCESSING:
                return { kind: 'processing', icon: 'schedule', label: 'Requested' };
            case MediaStatus.PENDING:
                return { kind: 'pending', icon: 'hourglass_empty', label: 'Pending approval' };
            case MediaStatus.BLOCKLISTED:
                return { kind: 'blocked', icon: 'block', label: 'Blocklisted' };
            default:
                return null;
        }
    }

    function requestsFor(mediaInfo, is4k) {
        const requests = mediaInfo && Array.isArray(mediaInfo.requests) ? mediaInfo.requests : [];
        return requests.filter(function (request) { return !!request.is4k === !!is4k; });
    }

    function ownPendingRequest(me, mediaInfo, is4k) {
        return requestsFor(mediaInfo, is4k).filter(function (request) {
            return request.status === RequestStatus.PENDING && isOwnRequest(me, request);
        })[0] || null;
    }

    // What the request area of a movie shows, for the standard or the 4K copy.
    function movieRequestState(details, me, is4k) {
        const mediaInfo = details && details.mediaInfo;
        const own = ownPendingRequest(me, mediaInfo, is4k);
        switch (mediaStatusOf(mediaInfo, is4k)) {
            case MediaStatus.AVAILABLE:
            case MediaStatus.PARTIALLY_AVAILABLE:
                return { state: 'available', own: null };
            case MediaStatus.PROCESSING:
                return { state: 'processing', own: null };
            case MediaStatus.PENDING:
                return { state: 'pending', own: own };
            case MediaStatus.BLOCKLISTED:
                return { state: 'blocked', own: null };
            default:
                return { state: canRequest(me, 'movie', is4k) ? 'requestable' : 'forbidden', own: null };
        }
    }

    function seasonsOf(details, settings) {
        const seasons = details && Array.isArray(details.seasons) ? details.seasons : [];
        const specials = !!(settings && settings.enableSpecialEpisodes);
        return seasons
            .filter(function (season) { return typeof season.seasonNumber === 'number' && (specials || season.seasonNumber > 0); })
            .sort(function (a, b) { return a.seasonNumber - b.seasonNumber; });
    }

    // One season's state. Availability reported by the media server wins; otherwise any
    // request that is not declined holds the season, as it does in Seerr's own UI.
    function seasonState(details, seasonNumber, is4k) {
        const mediaInfo = details && details.mediaInfo;
        const known = mediaInfo && Array.isArray(mediaInfo.seasons)
            ? mediaInfo.seasons.filter(function (season) { return season.seasonNumber === seasonNumber; })[0]
            : null;
        switch (known ? (is4k ? known.status4k : known.status) : MediaStatus.UNKNOWN) {
            case MediaStatus.AVAILABLE:
                return 'available';
            case MediaStatus.PARTIALLY_AVAILABLE:
                return 'partial';
            case MediaStatus.PROCESSING:
                return 'processing';
            case MediaStatus.PENDING:
                return 'pending';
            default:
                break;
        }

        const holding = requestsFor(mediaInfo, is4k).filter(function (request) {
            return request.status !== RequestStatus.DECLINED
                && Array.isArray(request.seasons)
                && request.seasons.some(function (season) { return season.seasonNumber === seasonNumber; });
        });
        if (holding.some(function (request) { return request.status === RequestStatus.PENDING; })) {
            return 'pending';
        }

        if (holding.some(function (request) { return request.status === RequestStatus.FAILED; })) {
            return 'failed';
        }

        return holding.length ? 'processing' : 'requestable';
    }

    function requestableSeasons(details, settings, is4k) {
        return seasonsOf(details, settings)
            .map(function (season) { return season.seasonNumber; })
            .filter(function (number) { return seasonState(details, number, is4k) === 'requestable'; });
    }

    function seriesRequestState(details, me, settings, is4k) {
        const status = mediaStatusOf(details && details.mediaInfo, is4k);
        if (status === MediaStatus.BLOCKLISTED) {
            return { state: 'blocked', open: [] };
        }

        const open = requestableSeasons(details, settings, is4k);
        if (open.length && !canRequest(me, 'tv', is4k)) {
            return { state: 'forbidden', open: open };
        }

        if (open.length) {
            return { state: 'requestable', open: open };
        }

        if (status === MediaStatus.AVAILABLE) {
            return { state: 'available', open: [] };
        }

        if (status === MediaStatus.PARTIALLY_AVAILABLE) {
            return { state: 'partial', open: [] };
        }

        return { state: status === MediaStatus.PENDING ? 'pending' : 'processing', open: [] };
    }

    // Seasons the request dialog would submit. When the server does not allow partial
    // requests, every season still open goes in together, as Seerr's own modal does.
    function seasonsToSubmit(selected, open, partialRequestsEnabled) {
        if (!partialRequestsEnabled) {
            return open.slice();
        }

        return selected.filter(function (number) { return open.indexOf(number) !== -1; })
            .sort(function (a, b) { return a - b; });
    }

    // A request body, built from the media only. The proxy strips identity fields anyway;
    // this never has any to strip.
    function buildRequestBody(mediaType, details, is4k, seasons) {
        const body = { mediaType: mediaType, mediaId: details.id, is4k: !!is4k };
        if (mediaType === 'tv') {
            body.seasons = seasons.slice();
            const tvdbId = details.externalIds && details.externalIds.tvdbId;
            if (typeof tvdbId === 'number' && tvdbId > 0) {
                body.tvdbId = tvdbId;
            }
        }

        return body;
    }

    // What Radarr or Sonarr is downloading for this media right now, as Seerr reports it, or
    // null. A series can have several episodes in flight; they are summed into one figure.
    function downloadProgress(mediaInfo, is4k) {
        const items = mediaInfo && Array.isArray(is4k ? mediaInfo.downloadStatus4k : mediaInfo.downloadStatus)
            ? (is4k ? mediaInfo.downloadStatus4k : mediaInfo.downloadStatus)
            : [];
        if (!items.length) {
            return null;
        }

        let size = 0;
        let left = 0;
        let eta = null;
        items.forEach(function (item) {
            if (typeof item.size === 'number' && item.size > 0 && typeof item.sizeLeft === 'number') {
                size += item.size;
                left += Math.max(0, Math.min(item.sizeLeft, item.size));
            }

            const finish = item.estimatedCompletionTime ? new Date(item.estimatedCompletionTime) : null;
            if (finish && !isNaN(finish.getTime()) && (!eta || finish > eta)) {
                eta = finish;
            }
        });

        return {
            count: items.length,
            percent: size > 0 ? Math.round((1 - left / size) * 100) : null,
            eta: eta
        };
    }

    function formatTimeLeft(eta, now) {
        if (!eta) {
            return '';
        }

        const minutes = Math.round((eta.getTime() - now) / 60000);
        if (minutes <= 1) {
            return 'almost done';
        }

        if (minutes < 90) {
            return 'about ' + minutes + ' minutes left';
        }

        const hours = Math.round(minutes / 60);
        return hours < 48 ? 'about ' + hours + ' hours left' : 'about ' + Math.round(hours / 24) + ' days left';
    }

    // Who holds requests for a title, for the line under its status. Other users' names are
    // only for users Seerr itself lets see other users' requests.
    function requestHolders(mediaInfo, me, is4k) {
        const active = requestsFor(mediaInfo, is4k).filter(function (request) { return request.status !== RequestStatus.DECLINED; });
        const own = active.filter(function (request) { return isOwnRequest(me, request); });
        const others = active.filter(function (request) { return !isOwnRequest(me, request); });
        const names = [];
        if (seesOtherUsersRequests(me)) {
            others.forEach(function (request) {
                const name = request.requestedBy && request.requestedBy.displayName;
                if (name && names.indexOf(name) === -1) {
                    names.push(name);
                }
            });
        }

        return { own: own, others: others, names: names };
    }

    function requestStatusLabel(request) {
        const media = request && request.media;
        switch (request && request.status) {
            case RequestStatus.PENDING:
                return { kind: 'pending', label: 'Pending approval' };
            case RequestStatus.DECLINED:
                return { kind: 'declined', label: 'Declined' };
            case RequestStatus.FAILED:
                return { kind: 'failed', label: 'Failed' };
            case RequestStatus.COMPLETED:
                return { kind: 'available', label: 'Available' };
            case RequestStatus.APPROVED: {
                const status = mediaStatusOf(media, request.is4k);
                if (status === MediaStatus.AVAILABLE) {
                    return { kind: 'available', label: 'Available' };
                }

                if (status === MediaStatus.PARTIALLY_AVAILABLE) {
                    return { kind: 'partial', label: 'Partially available' };
                }

                return { kind: 'processing', label: 'Approved' };
            }
            default:
                return { kind: 'unknown', label: 'Unknown' };
        }
    }

    // The Seerr request list filters this page offers, mapped onto Seerr's filter values.
    const REQUEST_FILTERS = [
        { id: 'all', label: 'All' },
        { id: 'pending', label: 'Pending' },
        { id: 'processing', label: 'Approved' },
        { id: 'available', label: 'Available' },
        { id: 'failed', label: 'Failed' }
    ];

    function normalizeFilter(value) {
        return REQUEST_FILTERS.some(function (filter) { return filter.id === value; }) ? value : 'all';
    }

    function titleOf(item) {
        return (item && (item.title || item.name || item.originalTitle || item.originalName)) || 'Untitled';
    }

    function yearOf(item) {
        const date = item && (item.releaseDate || item.firstAirDate);
        return typeof date === 'string' && /^\d{4}/.test(date) ? date.slice(0, 4) : '';
    }

    // Only plain TMDB image paths, so a value from upstream can never break out of a URL.
    function imageUrl(path, size) {
        return typeof path === 'string' && /^\/[A-Za-z0-9._-]+$/.test(path) ? TMDB_IMAGES + size + path : '';
    }

    function isMediaResult(item) {
        return !!item && (item.mediaType === 'movie' || item.mediaType === 'tv') && typeof item.id === 'number';
    }

    function positiveInt(value) {
        const number = Number(value);
        return Number.isInteger(number) && number > 0 ? number : null;
    }

    // The page's own route. Anything else belongs to Jellyfin.
    function parseRoute(hash) {
        if (typeof hash !== 'string' || hash.charAt(0) !== '#') {
            return null;
        }

        const raw = hash.slice(1);
        const queryStart = raw.indexOf('?');
        const path = (queryStart === -1 ? raw : raw.slice(0, queryStart)).replace(/\/+$/, '');
        if (path.toLowerCase() !== ROUTE) {
            return null;
        }

        const params = new URLSearchParams(queryStart === -1 ? '' : raw.slice(queryStart + 1));
        const view = params.get('view');
        const id = positiveInt(params.get('id'));
        if ((view === 'movie' || view === 'tv') && id) {
            return { view: view, id: id };
        }

        if (view === 'search') {
            const query = (params.get('q') || '').trim();
            return query ? { view: 'search', query: query.slice(0, 200) } : { view: 'discover' };
        }

        if (view === 'requests') {
            return { view: 'requests', filter: normalizeFilter(params.get('filter')) };
        }

        return { view: 'discover' };
    }

    function routeHash(route) {
        const params = new URLSearchParams();
        if (route.view === 'movie' || route.view === 'tv') {
            params.set('view', route.view);
            params.set('id', String(route.id));
        } else if (route.view === 'search' && route.query) {
            params.set('view', 'search');
            params.set('q', route.query);
        } else if (route.view === 'requests') {
            params.set('view', 'requests');
            if (route.filter && route.filter !== 'all') {
                params.set('filter', route.filter);
            }
        }

        const query = params.toString();
        return '#' + ROUTE + (query ? '?' + query : '');
    }

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---------------------------------------------------------------------------------
    // Proxy client. The one place this page talks to the server.
    // ---------------------------------------------------------------------------------

    function ApiError(status, code, message, retryAfter) {
        this.name = 'ApiError';
        this.status = status;
        this.code = code || '';
        this.message = message || '';
        this.retryAfter = retryAfter > 0 ? retryAfter : 0;
    }

    ApiError.prototype = Object.create(Error.prototype);
    ApiError.prototype.constructor = ApiError;

    function createApi(fetchImpl, getClient) {
        // The user's own Jellyfin authorization, exactly as Jellyfin Web sends it. Plain
        // fetch rather than ApiClient.ajax, so a Seerr refusal can never reach Jellyfin
        // Web's own request-failure handling.
        function headers(hasBody) {
            const result = { Accept: 'application/json' };
            const client = getClient();
            if (client && typeof client.setRequestHeaders === 'function') {
                client.setRequestHeaders(result);
            }

            if (!result.Authorization && client && typeof client.accessToken === 'function' && client.accessToken()) {
                result.Authorization = 'MediaBrowser Token="' + client.accessToken() + '"';
            }

            if (hasBody) {
                result['Content-Type'] = 'application/json';
            }

            return result;
        }

        function url(path, query) {
            const client = getClient();
            if (!client || typeof client.getUrl !== 'function') {
                throw new ApiError(401, 'MissingJellyfinUser', '');
            }

            return client.getUrl(PROXY_PATH + path, query);
        }

        function readJson(response) {
            if (response.status === 204) {
                return Promise.resolve(null);
            }

            return response.text().then(function (text) {
                if (!text) {
                    return null;
                }

                try {
                    return JSON.parse(text);
                } catch (e) {
                    return null;
                }
            });
        }

        function call(method, path, options) {
            const opts = options || {};
            const hasBody = opts.body !== undefined;
            let target;
            try {
                target = url(path, opts.query);
            } catch (e) {
                return Promise.reject(e);
            }

            return fetchImpl(target, {
                method: method,
                headers: headers(hasBody),
                body: hasBody ? JSON.stringify(opts.body) : undefined,
                cache: 'no-store'
            }).then(function (response) {
                return readJson(response).then(function (data) {
                    if (response.ok) {
                        return response.status === 202 ? { accepted: true, data: data } : data;
                    }

                    const retryAfter = parseInt(response.headers && response.headers.get('Retry-After'), 10);
                    throw new ApiError(
                        response.status,
                        data && (data.Error || data.error),
                        data && (data.Message || data.message),
                        retryAfter);
                });
            }, function () {
                throw new ApiError(0, 'NetworkError', '');
            });
        }

        return {
            get: function (path, query) { return call('GET', 'api/v1/' + path, { query: query }); },
            post: function (path, body) { return call('POST', 'api/v1/' + path, { body: body }); },
            put: function (path, body) { return call('PUT', 'api/v1/' + path, { body: body }); },
            remove: function (path) { return call('DELETE', 'api/v1/' + path); }
        };
    }

    // What to tell the user about a failed call. `blocking` errors replace the whole page.
    function describeError(error) {
        if (!(error instanceof ApiError)) {
            return { blocking: false, title: 'Something went wrong', text: 'The page hit an unexpected problem. Reload and try again.' };
        }

        const seerrSays = error.code === 'SeerrError' && error.message ? error.message : '';
        switch (error.status) {
            case 0:
                return { blocking: false, title: 'Connection problem', text: 'Jellyfin could not be reached. Check your connection and try again.' };
            case 401:
                if (error.code === 'MissingJellyfinUser') {
                    return { blocking: true, kind: 'session', title: 'Signed out', text: 'Your Jellyfin session has ended. Sign in again to use Requests.' };
                }

                return { blocking: false, title: 'Not allowed', text: seerrSays || 'Seerr did not allow that.' };
            case 403:
                if (error.code === 'PluginDisabled') {
                    return { blocking: true, kind: 'disabled', title: 'Requests are switched off', text: 'The server admin has switched off Seerr requests on this server.' };
                }

                return { blocking: false, title: 'Not allowed', text: seerrSays || 'Your Seerr account is not allowed to do that.' };
            case 404:
                if (error.code === 'SeerrUserNotLinked') {
                    return { blocking: true, kind: 'unlinked', title: 'Your account is not linked', text: 'Your Jellyfin account is not linked to a Seerr account yet. Ask the server admin to import you in Seerr, then come back here.' };
                }

                if (error.code === 'PluginInactive' || !error.code) {
                    return { blocking: true, kind: 'proxy', title: 'Requests are unavailable', text: 'Seerr Proxy is not installed or not active on this server. Ask the server admin to set it up.' };
                }

                if (error.code === 'UnsupportedProxyEndpoint') {
                    return { blocking: false, title: 'Not available', text: 'This server\'s Seerr Proxy does not offer that action.' };
                }

                return { blocking: false, title: 'Not found', text: seerrSays || 'Seerr could not find that title.' };
            case 409:
                return { blocking: false, title: 'Already requested', text: seerrSays || 'Seerr already has a request for this.' };
            case 413:
                return { blocking: false, title: 'Request too large', text: 'That request was larger than the server accepts.' };
            case 429:
                return { blocking: false, title: 'Slow down', text: 'Too many requests at once. Try again in ' + (error.retryAfter || 60) + ' seconds.' };
            case 502:
                if (error.code === 'SeerrUnreachable') {
                    return { blocking: true, kind: 'unreachable', title: 'Seerr is unreachable', text: 'The server cannot reach Seerr right now. Try again in a little while.' };
                }

                return { blocking: false, title: 'Seerr had a problem', text: seerrSays || 'Seerr could not complete that. Try again later.' };
            case 503:
                return { blocking: true, kind: 'unconfigured', title: 'Requests are not set up', text: 'Seerr Proxy has not been connected to Seerr yet. Ask the server admin to finish its settings.' };
            default:
                return { blocking: false, title: 'Something went wrong', text: seerrSays || error.message || ('The server answered with HTTP ' + error.status + '.') };
        }
    }

    const model = {
        Permission: Permission,
        MediaStatus: MediaStatus,
        RequestStatus: RequestStatus,
        hasPermission: hasPermission,
        canRequest: canRequest,
        is4kEnabled: is4kEnabled,
        canManageRequests: canManageRequests,
        seesOtherUsersRequests: seesOtherUsersRequests,
        canCancelRequest: canCancelRequest,
        canEditRequest: canEditRequest,
        badgeFor: badgeFor,
        movieRequestState: movieRequestState,
        seasonsOf: seasonsOf,
        seasonState: seasonState,
        requestableSeasons: requestableSeasons,
        seriesRequestState: seriesRequestState,
        seasonsToSubmit: seasonsToSubmit,
        buildRequestBody: buildRequestBody,
        downloadProgress: downloadProgress,
        formatTimeLeft: formatTimeLeft,
        requestHolders: requestHolders,
        requestStatusLabel: requestStatusLabel,
        normalizeFilter: normalizeFilter,
        titleOf: titleOf,
        yearOf: yearOf,
        imageUrl: imageUrl,
        parseRoute: parseRoute,
        routeHash: routeHash,
        escapeHtml: escapeHtml,
        createApi: createApi,
        describeError: describeError,
        ApiError: ApiError
    };

    window.SeerrIntegration = { version: VERSION, model: model };

    if (window.__seerrIntegrationNoInit) {
        return;
    }

    // ---------------------------------------------------------------------------------
    // State. Everything is keyed to the signed-in user, so switching users in one tab never
    // shows the previous user's data.
    // ---------------------------------------------------------------------------------

    const api = createApi(function (input, init) { return window.fetch(input, init); }, function () { return window.ApiClient; });
    let session = null;
    let sessionPromise = null;
    let sessionKeyCache = '';
    const detailCache = new Map();
    const discoverCache = new Map();
    let renderToken = 0;
    let currentRoute = null;
    let lastHash = null;

    function currentSessionKey() {
        const client = window.ApiClient;
        if (!client || typeof client.getCurrentUserId !== 'function') {
            return '';
        }

        const userId = client.getCurrentUserId();
        const token = typeof client.accessToken === 'function' ? client.accessToken() : '';
        return userId && token ? userId + ':' + token : '';
    }

    function resetIfUserChanged() {
        const key = currentSessionKey();
        if (key !== sessionKeyCache) {
            sessionKeyCache = key;
            session = null;
            sessionPromise = null;
            detailCache.clear();
            discoverCache.clear();
        }

        return key;
    }

    // The Try again button clears `session`, which makes the next call ask Seerr again.
    function loadSession() {
        const key = resetIfUserChanged();
        if (!key) {
            return Promise.reject(new ApiError(401, 'MissingJellyfinUser', ''));
        }

        if (session && Date.now() - session.loadedAt < SESSION_TTL_MS) {
            return Promise.resolve(session);
        }

        if (sessionPromise) {
            return sessionPromise;
        }

        // auth/me is the gate: it fails with a precise reason when the proxy is missing,
        // switched off, unconfigured, or the user is not linked in Seerr.
        sessionPromise = Promise.all([
            api.get('auth/me'),
            api.get('settings/public').catch(function () { return {}; })
        ]).then(function (results) {
            if (currentSessionKey() !== key) {
                throw new ApiError(401, 'MissingJellyfinUser', '');
            }

            session = { key: key, me: results[0] || {}, settings: results[1] || {}, loadedAt: Date.now() };
            sessionPromise = null;
            return session;
        }, function (error) {
            sessionPromise = null;
            throw error;
        });

        return sessionPromise;
    }

    function cached(map, key, ttl, load) {
        const hit = map.get(key);
        if (hit && Date.now() - hit.at < ttl) {
            return hit.promise;
        }

        const promise = load().catch(function (error) {
            map.delete(key);
            throw error;
        });
        map.set(key, { at: Date.now(), promise: promise });
        return promise;
    }

    function getDetails(mediaType, id, fresh) {
        const key = mediaType + ':' + id;
        if (fresh) {
            detailCache.delete(key);
        }

        return cached(detailCache, key, DETAIL_TTL_MS, function () { return api.get(mediaType + '/' + id); });
    }

    function forgetMedia(mediaType, id) {
        detailCache.delete(mediaType + ':' + id);
        discoverCache.clear();
    }

    // ---------------------------------------------------------------------------------
    // Styles. Scoped to this page's own elements and themed with the variables Jellyfin's
    // themes already define, with the dark theme's values as fallbacks.
    // ---------------------------------------------------------------------------------

    const STYLE = `
#${PAGE_ID}, .sui-layer {
  --sui-accent: var(--jf-palette-primary-main, #00a4dc);
  --sui-accent-text: var(--jf-palette-primary-contrastText, rgba(0, 0, 0, 0.87));
  --sui-text: var(--jf-palette-text-primary, #fff);
  --sui-muted: var(--jf-palette-text-secondary, rgba(255, 255, 255, 0.7));
  --sui-paper: var(--jf-palette-background-paper, #202020);
  --sui-ground: var(--jf-palette-background-default, #101010);
  --sui-divider: var(--jf-palette-divider, rgba(255, 255, 255, 0.12));
  --sui-hover: var(--jf-palette-action-hover, rgba(255, 255, 255, 0.08));
  --sui-field: var(--jf-palette-FilledInput-bg, rgba(255, 255, 255, 0.09));
  --sui-error: var(--jf-palette-error-main, #f44336);
  --sui-ok: #43a047;
  --sui-partial: #7cb342;
  --sui-processing: #5c6bc0;
  --sui-pending: #f9a825;
  --sui-bad: #e53935;
}
html.${ACTIVE_CLASS} .mainAnimatedPage:not(#${PAGE_ID}) { display: none !important; }
#${PAGE_ID} { color: var(--sui-text); position: relative; }
#${PAGE_ID} .sui-root { position: relative; padding-bottom: 3em; }
#${PAGE_ID} .sui-page-backdrop { position: absolute; left: 0; right: 0; top: 0; height: 38em; background-size: cover; background-position: center 20%; opacity: 0.3; pointer-events: none; -webkit-mask-image: linear-gradient(to bottom, #000 35%, transparent); mask-image: linear-gradient(to bottom, #000 35%, transparent); }
#${PAGE_ID} .sui-page-backdrop[hidden] { display: none; }
#${PAGE_ID}.sui-blocked .sui-toolbar { display: none; }
#${PAGE_ID} .sui-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75em 1.5em; margin: 0.5em 0 1em; }
#${PAGE_ID} .sui-tabs { display: flex; gap: 0.25em; flex-wrap: wrap; }
#${PAGE_ID} .sui-tab { color: var(--sui-muted); text-decoration: none; padding: 0.5em 0.9em; border-radius: 2em; font-weight: 500; }
#${PAGE_ID} .sui-tab:hover, #${PAGE_ID} .sui-tab:focus-visible { background: var(--sui-hover); color: var(--sui-text); outline: none; }
#${PAGE_ID} .sui-tab-active { color: var(--sui-accent-text); background: var(--sui-accent); }
#${PAGE_ID} .sui-tab-active:hover, #${PAGE_ID} .sui-tab-active:focus-visible { color: var(--sui-accent-text); background: var(--sui-accent); }
#${PAGE_ID} .sui-search { flex: 1 1 18em; max-width: 32em; display: flex; align-items: center; gap: 0.5em; background: var(--sui-field); border-radius: 2em; padding: 0 0.9em; }
#${PAGE_ID} .sui-search .material-icons { color: var(--sui-muted); }
#${PAGE_ID} .sui-search input { flex: 1; min-width: 0; background: transparent; border: 0; color: var(--sui-text); font: inherit; padding: 0.65em 0; outline: none; }
#${PAGE_ID} .sui-section { margin-top: 0.5em; }
#${PAGE_ID} .sui-section-title { display: flex; align-items: center; justify-content: space-between; gap: 1em; }
#${PAGE_ID} .sui-row-wrap { position: relative; }
#${PAGE_ID} .sui-row { white-space: nowrap; padding: 0.2em 0 0.6em; scroll-behavior: smooth; }
#${PAGE_ID} .sui-row > .card { display: inline-block; vertical-align: top; white-space: normal; }
#${PAGE_ID} .sui-arrow { position: absolute; top: 35%; z-index: 2; width: 2.4em; height: 2.4em; border-radius: 50%; border: 0; cursor: pointer; color: #fff; background: rgba(0, 0, 0, 0.6); display: none; align-items: center; justify-content: center; }
#${PAGE_ID} .sui-arrow-prev { left: 0.2em; }
#${PAGE_ID} .sui-arrow-next { right: 0.2em; }
@media (hover: hover) and (pointer: fine) { #${PAGE_ID} .sui-row-wrap:hover .sui-arrow { display: flex; } }
#${PAGE_ID} .sui-grid { margin: 0 -0.4em; }
#${PAGE_ID} .card .cardImageContainer { text-decoration: none; }
#${PAGE_ID} .sui-placeholder { align-items: center; justify-content: center; }
#${PAGE_ID} .sui-placeholder .material-icons { font-size: 3em; opacity: 0.6; }
#${PAGE_ID} .sui-badge { position: absolute; top: 0.75em; right: 0.75em; width: 1.6em; height: 1.6em; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45); pointer-events: none; }
#${PAGE_ID} .sui-badge .material-icons { font-size: 1.05em; }
#${PAGE_ID} .sui-card-link { color: inherit; text-decoration: none; }
.sui-kind-available { background: var(--sui-ok); }
.sui-kind-partial { background: var(--sui-partial); }
.sui-kind-processing { background: var(--sui-processing); }
.sui-kind-pending { background: var(--sui-pending); color: #000 !important; }
.sui-kind-blocked, .sui-kind-declined, .sui-kind-failed { background: var(--sui-bad); }
.sui-kind-unknown { background: var(--sui-hover); }
#${PAGE_ID} .sui-chip, .sui-layer .sui-chip { display: inline-flex; align-items: center; gap: 0.35em; padding: 0.2em 0.7em; border-radius: 1em; font-size: 0.85em; font-weight: 600; color: #fff; white-space: nowrap; }
#${PAGE_ID} .sui-chip .material-icons, .sui-layer .sui-chip .material-icons { font-size: 1.1em; }
#${PAGE_ID} .sui-muted { color: var(--sui-muted); }
#${PAGE_ID} .sui-message { max-width: 34em; margin: 4em auto; text-align: center; }
#${PAGE_ID} .sui-message .material-icons { font-size: 3em; color: var(--sui-muted); }
#${PAGE_ID} .sui-message h2 { margin: 0.4em 0; }
#${PAGE_ID} .sui-message p { color: var(--sui-muted); line-height: 1.5; }
#${PAGE_ID} .sui-loading { display: flex; justify-content: center; padding: 3em 0; }
.sui-spinner { width: 2.2em; height: 2.2em; border-radius: 50%; border: 0.22em solid var(--sui-hover); border-top-color: var(--sui-accent); animation: sui-spin 0.9s linear infinite; }
@keyframes sui-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .sui-spinner { animation-duration: 3s; } #${PAGE_ID} .sui-row { scroll-behavior: auto; } }
#${PAGE_ID} .sui-btn, .sui-layer .sui-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.4em; border: 0; border-radius: 0.3em; padding: 0.6em 1.15em; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; color: var(--sui-text); background: var(--sui-hover); }
#${PAGE_ID} .sui-btn:hover, .sui-layer .sui-btn:hover { filter: brightness(1.15); }
#${PAGE_ID} .sui-btn:focus-visible, .sui-layer .sui-btn:focus-visible { outline: 2px solid var(--sui-accent); outline-offset: 2px; }
#${PAGE_ID} .sui-btn[disabled], .sui-layer .sui-btn[disabled] { opacity: 0.5; cursor: default; filter: none; }
#${PAGE_ID} .sui-btn .material-icons, .sui-layer .sui-btn .material-icons { font-size: 1.25em; }
#${PAGE_ID} .sui-btn-primary, .sui-layer .sui-btn-primary { background: var(--sui-accent); color: var(--sui-accent-text); }
#${PAGE_ID} .sui-btn-danger, .sui-layer .sui-btn-danger { background: transparent; color: var(--sui-error); box-shadow: inset 0 0 0 1px var(--sui-error); }
#${PAGE_ID} .sui-btn-small { padding: 0.35em 0.8em; font-size: 0.9em; }
#${PAGE_ID} .sui-details { position: relative; }
#${PAGE_ID} .sui-details-main { position: relative; display: flex; gap: 2em; align-items: flex-start; padding-top: 1em; }
#${PAGE_ID} .sui-details-poster { flex: 0 0 auto; width: 13em; aspect-ratio: 2 / 3; border-radius: 0.4em; background-size: cover; background-position: center; box-shadow: 0 0.4em 1.6em rgba(0, 0, 0, 0.45); }
#${PAGE_ID} .sui-details-info { flex: 1 1 auto; min-width: 0; }
#${PAGE_ID} .sui-details-title { margin: 0 0 0.3em; font-size: 2em; line-height: 1.2; }
#${PAGE_ID} .sui-details-facts { color: var(--sui-muted); margin-bottom: 0.9em; }
#${PAGE_ID} .sui-details-tagline { font-style: italic; color: var(--sui-muted); margin: 0 0 0.6em; }
#${PAGE_ID} .sui-details-overview { line-height: 1.55; max-width: 60em; }
#${PAGE_ID} .sui-actions { display: flex; flex-wrap: wrap; gap: 0.6em; align-items: center; margin: 0.4em 0 1.2em; }
#${PAGE_ID} .sui-note { color: var(--sui-muted); font-size: 0.92em; }
#${PAGE_ID} .sui-seasons { margin-top: 1.5em; max-width: 44em; }
#${PAGE_ID} .sui-season { display: flex; align-items: center; justify-content: space-between; gap: 1em; padding: 0.7em 0; border-bottom: 1px solid var(--sui-divider); }
#${PAGE_ID} .sui-request-row { display: flex; gap: 1em; padding: 0.9em 0; border-bottom: 1px solid var(--sui-divider); align-items: flex-start; }
#${PAGE_ID} .sui-request-poster { flex: 0 0 auto; width: 4.5em; aspect-ratio: 2 / 3; border-radius: 0.3em; background: var(--sui-hover) center / cover no-repeat; }
#${PAGE_ID} .sui-request-body { flex: 1 1 auto; min-width: 0; }
#${PAGE_ID} .sui-request-title { font-weight: 600; font-size: 1.1em; color: inherit; text-decoration: none; }
#${PAGE_ID} .sui-request-meta { display: flex; flex-wrap: wrap; gap: 0.4em 0.9em; align-items: center; margin: 0.35em 0; color: var(--sui-muted); font-size: 0.92em; }
#${PAGE_ID} .sui-request-actions { display: flex; flex-wrap: wrap; gap: 0.5em; margin-top: 0.5em; }
#${PAGE_ID} .sui-progress { max-width: 30em; margin: 0.6em 0 0.4em; }
#${PAGE_ID} .sui-progress-label { display: flex; align-items: center; justify-content: space-between; gap: 0.8em; font-size: 0.92em; color: var(--sui-muted); margin-bottom: 0.35em; }
#${PAGE_ID} .sui-progress-track { height: 0.35em; border-radius: 0.2em; background: var(--sui-hover); overflow: hidden; }
#${PAGE_ID} .sui-progress-bar { height: 100%; background: var(--sui-accent); }
#${PAGE_ID} .sui-filters { display: flex; flex-wrap: wrap; gap: 0.5em; margin-bottom: 0.5em; }
#${PAGE_ID} .sui-more { display: flex; justify-content: center; margin: 1.5em 0; }
@media (max-width: 50em) {
  #${PAGE_ID} .sui-details-main { flex-direction: column; align-items: center; text-align: center; }
  #${PAGE_ID} .sui-details-poster { width: 10em; }
  #${PAGE_ID} .sui-actions { justify-content: center; }
  #${PAGE_ID} .sui-details .sui-progress { margin-left: auto; margin-right: auto; text-align: left; }
  #${PAGE_ID} .sui-details-title { font-size: 1.6em; }
  #${PAGE_ID} .sui-search { max-width: none; }
}
.sui-layer { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.6); padding: 1em; color: var(--sui-text); }
.sui-dialog { width: 100%; max-width: 30em; max-height: 100%; overflow: auto; background: var(--sui-paper); border-radius: 0.6em; box-shadow: 0 1em 3em rgba(0, 0, 0, 0.5); padding: 1.4em 1.4em 1em; outline: none; }
.sui-dialog h2 { margin: 0 0 0.3em; font-size: 1.3em; }
.sui-dialog p { color: var(--sui-muted); line-height: 1.5; margin: 0.4em 0 1em; }
.sui-dialog-list { margin: 0.5em 0 1em; border-top: 1px solid var(--sui-divider); }
.sui-dialog-item { display: flex; align-items: center; gap: 0.8em; padding: 0.65em 0.2em; border-bottom: 1px solid var(--sui-divider); cursor: pointer; }
.sui-dialog-item input { width: 1.2em; height: 1.2em; accent-color: var(--sui-accent); margin: 0; }
.sui-dialog-item.sui-locked { cursor: default; opacity: 0.75; }
.sui-dialog-item-text { flex: 1 1 auto; min-width: 0; }
.sui-dialog-item-text small { display: block; color: var(--sui-muted); }
.sui-dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 0.6em; margin-top: 0.4em; }
.sui-toast { position: fixed; left: 50%; bottom: 2em; transform: translateX(-50%); z-index: 1200; max-width: calc(100% - 2em); background: var(--jf-palette-SnackbarContent-bg, #323232); color: var(--jf-palette-SnackbarContent-color, #fff); padding: 0.8em 1.2em; border-radius: 0.4em; box-shadow: 0 0.3em 1em rgba(0, 0, 0, 0.4); }
`;

    function injectStyles() {
        if (document.getElementById('seerr-integration-style')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'seerr-integration-style';
        style.textContent = STYLE;
        document.head.appendChild(style);
    }

    // ---------------------------------------------------------------------------------
    // Navigation entries.
    // ---------------------------------------------------------------------------------

    function isSignedIn() {
        return !!currentSessionKey();
    }

    function removeNav() {
        document.querySelectorAll('[' + NAV_ATTR + ']').forEach(function (node) { node.remove(); });
    }

    function setLastTextNode(element, text) {
        for (let node = element.lastChild; node; node = node.previousSibling) {
            if (node.nodeType === 3 && node.textContent.trim()) {
                node.textContent = text;
                return true;
            }
        }

        return false;
    }

    // The legacy drawer, used by the Desktop, Mobile and TV display modes: right after Home,
    // where Jellyfin puts its own custom menu links.
    function ensureLegacyDrawerEntry(active) {
        const drawer = document.querySelector('.mainDrawer-scrollContainer');
        if (!drawer) {
            return;
        }

        let link = drawer.querySelector('[' + NAV_ATTR + '="drawer"]');
        if (!link) {
            const home = drawer.querySelector('a.navMenuOption[href="#/home"]');
            if (!home) {
                return;
            }

            link = document.createElement('a');
            link.setAttribute('is', 'emby-linkbutton');
            link.setAttribute(NAV_ATTR, 'drawer');
            link.className = 'navMenuOption lnkMediaFolder emby-button';
            link.href = '#' + ROUTE;
            link.innerHTML = '<span class="material-icons navMenuOptionIcon" aria-hidden="true">add_to_queue</span>'
                + '<span class="sectionName navMenuOptionText">Requests</span>';
            const anchor = drawer.querySelector('.customMenuOptions');
            const after = anchor && anchor.parentNode === home.parentNode ? anchor : home;
            after.parentNode.insertBefore(link, after.nextSibling);
        }

        link.classList.toggle('navMenuOption-selected', active);
    }

    // The Modern app bar on wide screens: a sibling of Favorites, cloned so it carries the
    // same Material UI classes and so follows the theme exactly.
    function ensureAppBarEntry() {
        const favorites = document.querySelector('.MuiAppBar-root a[href="#/home?tab=1"]');
        if (!favorites || favorites.parentNode.querySelector('[' + NAV_ATTR + '="appbar"]')) {
            return;
        }

        const link = favorites.cloneNode(true);
        link.setAttribute(NAV_ATTR, 'appbar');
        link.setAttribute('href', '#' + ROUTE);
        link.removeAttribute('aria-current');
        link.classList.remove('Mui-selected');
        const path = link.querySelector('svg path');
        if (path) {
            path.setAttribute('d', ADD_TO_QUEUE_PATH);
            Array.prototype.slice.call(link.querySelectorAll('svg path'), 1).forEach(function (extra) { extra.remove(); });
        }

        if (!setLastTextNode(link, 'Requests')) {
            link.appendChild(document.createTextNode('Requests'));
        }

        favorites.parentNode.insertBefore(link, favorites.nextSibling);
    }

    // The Modern menu that replaces the app bar links on narrow screens. Material UI mounts it
    // only while open, so the entry is added each time it appears.
    function ensureModernMenuEntry(active) {
        const favorites = document.querySelector('.MuiDrawer-root a[href="#/home?tab=1"]');
        if (!favorites) {
            return;
        }

        const item = favorites.closest('li') || favorites;
        let entry = item.parentNode.querySelector('[' + NAV_ATTR + '="menu"]');
        if (!entry) {
            entry = item.cloneNode(true);
            entry.setAttribute(NAV_ATTR, 'menu');
            const link = entry.matches('a') ? entry : entry.querySelector('a');
            link.setAttribute('href', '#' + ROUTE);
            link.classList.remove('Mui-selected');
            const path = link.querySelector('svg path');
            if (path) {
                path.setAttribute('d', ADD_TO_QUEUE_PATH);
            }

            const label = link.querySelector('.MuiListItemText-primary') || link.querySelector('.MuiTypography-root');
            if (label) {
                label.textContent = 'Requests';
            } else {
                setLastTextNode(link, 'Requests');
            }

            // The clone has none of React's handlers, so close the menu the way a click
            // outside it would.
            link.addEventListener('click', function () {
                const root = link.closest('.MuiDrawer-root');
                const backdrop = root && root.querySelector('.MuiBackdrop-root');
                if (backdrop) {
                    setTimeout(function () { backdrop.click(); }, 0);
                }
            });
            item.parentNode.insertBefore(entry, item.nextSibling);
        }

        const entryLink = entry.matches('a') ? entry : entry.querySelector('a');
        if (entryLink) {
            entryLink.classList.toggle('Mui-selected', active);
        }
    }

    function ensureNav() {
        if (!isSignedIn()) {
            removeNav();
            return;
        }

        const active = !!parseRoute(window.location.hash);
        ensureLegacyDrawerEntry(active);
        ensureAppBarEntry();
        ensureModernMenuEntry(active);
    }

    // Runs at most once a frame for any DOM change. Jellyfin Web's router navigates with
    // pushState, which fires no event, but every navigation renders a page, so this is
    // also where such a navigation away from the Requests page is noticed.
    let navQueued = false;
    function queueNav() {
        if (navQueued) {
            return;
        }

        navQueued = true;
        requestAnimationFrame(function () {
            navQueued = false;
            try {
                if (window.location.hash !== lastHash) {
                    onLocationChange();
                }

                ensureNav();
            } catch (e) {
                console.error('Seerr Integration: could not add the Requests entry', e);
            }
        });
    }

    // ---------------------------------------------------------------------------------
    // Page host.
    // ---------------------------------------------------------------------------------

    function pageElement() {
        let page = document.getElementById(PAGE_ID);
        if (!page) {
            page = document.createElement('div');
            page.id = PAGE_ID;
            page.className = 'page libraryPage mainAnimatedPage hide';
            page.setAttribute('data-title', 'Requests');
            page.setAttribute('data-backbutton', 'true');
            page.setAttribute('role', 'main');
            page.innerHTML = '<div class="sui-page-backdrop" aria-hidden="true" hidden></div>'
                + '<div class="padded-left padded-right sui-root">'
                + '<div class="sui-toolbar">'
                + '<nav class="sui-tabs" aria-label="Requests sections"></nav>'
                + '<form class="sui-search" role="search">'
                + '<span class="material-icons" aria-hidden="true">search</span>'
                + '<input type="search" name="q" autocomplete="off" spellcheck="false" placeholder="Search movies and series" aria-label="Search movies and series" maxlength="200">'
                + '</form>'
                + '</div>'
                + '<div class="sui-view"></div>'
                + '</div>';
            const host = document.querySelector('.mainAnimatedPages') || document.querySelector('#reactRoot') || document.body;
            host.appendChild(page);
            bindPage(page);
        }

        return page;
    }

    function showPage() {
        injectStyles();
        const page = pageElement();
        document.documentElement.classList.add(ACTIVE_CLASS);
        if (page.classList.contains('hide')) {
            page.classList.remove('hide');
            announce(page);
        }

        return page;
    }

    // The events Jellyfin Web's own pages raise. Its legacy header answers them by clearing
    // the previous page's section tabs, showing this page's title and back button, and
    // scrolling to the top. In the Modern layout nothing listens, and they do nothing.
    function announce(page) {
        ['pagebeforeshow', 'pageshow'].forEach(function (type) {
            page.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: { isRestored: false } }));
        });
        document.title = 'Requests';
    }

    function setBackdrop(page, url) {
        const backdrop = page.querySelector('.sui-page-backdrop');
        if (url) {
            backdrop.style.backgroundImage = 'url("' + url + '")';
            backdrop.hidden = false;
        } else {
            backdrop.hidden = true;
            backdrop.style.backgroundImage = '';
        }
    }

    function hidePage() {
        document.documentElement.classList.remove(ACTIVE_CLASS);
        const page = document.getElementById(PAGE_ID);
        if (page) {
            page.classList.add('hide');
            const view = page.querySelector('.sui-view');
            if (view) {
                view.innerHTML = '';
            }
        }

        currentRoute = null;
        renderToken++;
        closeLayers();
    }

    function onLocationChange() {
        const hash = window.location.hash;
        if (hash === lastHash) {
            return;
        }

        lastHash = hash;
        const route = parseRoute(hash);
        queueNav();
        if (!route || !isSignedIn()) {
            if (currentRoute) {
                hidePage();
            }

            return;
        }

        resetIfUserChanged();
        const page = showPage();
        const sameView = currentRoute && currentRoute.view === route.view && currentRoute.id === route.id;
        currentRoute = route;
        renderRoute(page, route, sameView);
    }

    function navigate(route, replace) {
        const hash = routeHash(route);
        if (replace) {
            history.replaceState(history.state, '', hash);
            onLocationChange();
        } else {
            window.location.hash = hash;
        }
    }

    // ---------------------------------------------------------------------------------
    // Rendering helpers.
    // ---------------------------------------------------------------------------------

    function messageHtml(icon, title, text, retry) {
        return '<div class="sui-message">'
            + '<span class="material-icons" aria-hidden="true">' + escapeHtml(icon) + '</span>'
            + '<h2>' + escapeHtml(title) + '</h2>'
            + '<p>' + escapeHtml(text) + '</p>'
            + (retry ? '<button type="button" class="sui-btn sui-btn-primary" data-action="retry"><span class="material-icons" aria-hidden="true">refresh</span>Try again</button>' : '')
            + '</div>';
    }

    function loadingHtml() {
        return '<div class="sui-loading" role="status" aria-label="Loading"><div class="sui-spinner"></div></div>';
    }

    const BLOCKING_ICONS = {
        session: 'lock',
        disabled: 'block',
        unlinked: 'link_off',
        proxy: 'extension_off',
        unreachable: 'cloud_off',
        unconfigured: 'settings'
    };

    function errorHtml(error) {
        const info = describeError(error);
        if (info.blocking) {
            return messageHtml(BLOCKING_ICONS[info.kind] || 'error_outline', info.title, info.text, info.kind === 'unreachable');
        }

        return messageHtml('error_outline', info.title, info.text, true);
    }

    function chipHtml(kind, label, icon) {
        return '<span class="sui-chip sui-kind-' + escapeHtml(kind) + '">'
            + (icon ? '<span class="material-icons" aria-hidden="true">' + escapeHtml(icon) + '</span>' : '')
            + escapeHtml(label) + '</span>';
    }

    function detailsRoute(item) {
        return { view: item.mediaType === 'tv' ? 'tv' : 'movie', id: item.id };
    }

    function cardHtml(item, overflow) {
        const route = detailsRoute(item);
        const href = routeHash(route);
        const title = titleOf(item);
        const year = yearOf(item);
        const poster = imageUrl(item.posterPath, 'w342');
        const badge = badgeFor(item.mediaInfo);
        const kind = item.mediaType === 'tv' ? 'Series' : 'Movie';
        const image = poster
            ? '<a class="cardImageContainer coveredImage cardContent sui-lazy" href="' + escapeHtml(href) + '" data-src="' + escapeHtml(poster) + '" aria-label="' + escapeHtml(title) + '"></a>'
            : '<a class="cardImageContainer coveredImage cardContent defaultCardBackground defaultCardBackground1 sui-placeholder" href="' + escapeHtml(href) + '" aria-label="' + escapeHtml(title) + '">'
                + '<span class="material-icons" aria-hidden="true">' + (item.mediaType === 'tv' ? 'tv' : 'movie') + '</span></a>';
        return '<div class="card ' + (overflow ? 'overflowPortraitCard' : 'portraitCard') + ' card-hoverable" data-media-type="' + escapeHtml(item.mediaType) + '" data-id="' + item.id + '">'
            + '<div class="cardBox cardBox-bottompadded">'
            + '<div class="cardScalable">'
            + '<div class="cardPadder cardPadder-portrait"></div>'
            + image
            + (badge ? '<span class="sui-badge sui-kind-' + badge.kind + '" title="' + escapeHtml(badge.label) + '"><span class="material-icons" aria-hidden="true">' + badge.icon + '</span></span>' : '')
            + '</div>'
            + '<div class="cardText cardTextCentered cardText-first"><bdi><a class="sui-card-link" href="' + escapeHtml(href) + '">' + escapeHtml(title) + '</a></bdi></div>'
            + '<div class="cardText cardTextCentered cardText-secondary"><bdi>' + escapeHtml(year ? year + ' · ' + kind : kind) + '</bdi></div>'
            + '</div>'
            + '</div>';
    }

    let lazyObserver = null;
    function loadImages(root) {
        const pending = root.querySelectorAll('.sui-lazy[data-src]');
        if (!('IntersectionObserver' in window)) {
            pending.forEach(showImage);
            return;
        }

        if (!lazyObserver) {
            lazyObserver = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        lazyObserver.unobserve(entry.target);
                        showImage(entry.target);
                    }
                });
            }, { rootMargin: '400px' });
        }

        pending.forEach(function (element) { lazyObserver.observe(element); });
    }

    function showImage(element) {
        const src = element.getAttribute('data-src');
        element.removeAttribute('data-src');
        if (src) {
            element.style.backgroundImage = 'url("' + src + '")';
        }
    }

    let toastTimer = 0;
    function toast(text) {
        let node = document.querySelector('.sui-toast');
        if (!node) {
            node = document.createElement('div');
            node.className = 'sui-toast';
            node.setAttribute('role', 'status');
            node.setAttribute('aria-live', 'polite');
            document.body.appendChild(node);
        }

        node.textContent = text;
        node.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { node.hidden = true; }, 4500);
    }

    function toastError(error) {
        const info = describeError(error);
        toast(info.text);
    }

    // ---------------------------------------------------------------------------------
    // Views.
    // ---------------------------------------------------------------------------------

    function renderTabs(page, route, me) {
        const tabs = page.querySelector('.sui-tabs');
        const requestsLabel = seesOtherUsersRequests(me) ? 'Requests' : 'My requests';
        const active = route.view === 'requests' ? 'requests' : (route.view === 'discover' || route.view === 'search' ? 'discover' : '');
        tabs.innerHTML = '<a class="sui-tab' + (active === 'discover' ? ' sui-tab-active' : '') + '" href="' + routeHash({ view: 'discover' }) + '"' + (active === 'discover' ? ' aria-current="page"' : '') + '>Discover</a>'
            + '<a class="sui-tab' + (active === 'requests' ? ' sui-tab-active' : '') + '" href="' + routeHash({ view: 'requests' }) + '"' + (active === 'requests' ? ' aria-current="page"' : '') + '>' + escapeHtml(requestsLabel) + '</a>';
        const input = page.querySelector('.sui-search input');
        if (document.activeElement !== input) {
            input.value = route.view === 'search' ? route.query : '';
        }
    }

    function renderRoute(page, route, sameView) {
        const token = ++renderToken;
        const view = page.querySelector('.sui-view');
        if (!sameView || route.view === 'requests' || route.view === 'search') {
            view.innerHTML = loadingHtml();
            view.__details = null;
        }

        if (route.view !== 'movie' && route.view !== 'tv') {
            setBackdrop(page, '');
        }

        loadSession().then(function (current) {
            if (token !== renderToken) {
                return null;
            }

            page.classList.remove('sui-blocked');
            renderTabs(page, route, current.me);
            switch (route.view) {
                case 'movie':
                case 'tv':
                    return renderDetails(view, route, current, token);
                case 'search':
                    return renderSearch(view, route, token);
                case 'requests':
                    return renderRequests(view, route, current, token);
                default:
                    return renderDiscover(view, current, token);
            }
        }).catch(function (error) {
            if (token === renderToken) {
                const blocking = describeError(error).blocking;
                page.classList.toggle('sui-blocked', blocking);
                if (blocking) {
                    setBackdrop(page, '');
                }

                view.innerHTML = errorHtml(error);
            }
        });
    }

    const DISCOVER_ROWS = [
        { id: 'trending', title: 'Trending', path: 'discover/trending' },
        { id: 'movies', title: 'Popular movies', path: 'discover/movies' },
        { id: 'tv', title: 'Popular series', path: 'discover/tv' },
        { id: 'upcoming-movies', title: 'Upcoming movies', path: 'discover/movies/upcoming' },
        { id: 'upcoming-tv', title: 'Upcoming series', path: 'discover/tv/upcoming' }
    ];

    // Seerr's own discover settings decide what its sliders hide; the page follows them.
    function discoverFilter(settings) {
        return function (item) {
            if (!isMediaResult(item)) {
                return false;
            }

            const status = mediaStatusOf(item.mediaInfo, false);
            if (settings.hideAvailable && (status === MediaStatus.AVAILABLE || status === MediaStatus.PARTIALLY_AVAILABLE)) {
                return false;
            }

            if (settings.hideBlocklisted && status === MediaStatus.BLOCKLISTED) {
                return false;
            }

            return !(settings.hideRequested && (status === MediaStatus.PENDING || status === MediaStatus.PROCESSING));
        };
    }

    function loadDiscoverPage(row, page) {
        return cached(discoverCache, row.path + '?' + page, DISCOVER_TTL_MS, function () {
            return api.get(row.path, { page: page });
        });
    }

    function renderDiscover(view, current, token) {
        view.innerHTML = DISCOVER_ROWS.map(function (row) {
            return '<section class="verticalSection sui-section" data-row="' + row.id + '">'
                + '<div class="sectionTitleContainer sui-section-title"><h2 class="sectionTitle sectionTitle-cards">' + escapeHtml(row.title) + '</h2></div>'
                + '<div class="sui-row-wrap">'
                + '<button type="button" class="sui-arrow sui-arrow-prev" data-action="scroll-row" data-direction="-1" aria-label="Scroll left"><span class="material-icons" aria-hidden="true">chevron_left</span></button>'
                + '<div class="itemsContainer scrollX hiddenScrollX sui-row">' + loadingHtml() + '</div>'
                + '<button type="button" class="sui-arrow sui-arrow-next" data-action="scroll-row" data-direction="1" aria-label="Scroll right"><span class="material-icons" aria-hidden="true">chevron_right</span></button>'
                + '</div>'
                + '</section>';
        }).join('');

        const keep = discoverFilter(current.settings || {});
        const loads = DISCOVER_ROWS.map(function (row) {
            const section = view.querySelector('[data-row="' + row.id + '"]');
            const container = section.querySelector('.sui-row');
            return loadDiscoverPage(row, 1).then(function (data) {
                if (token !== renderToken) {
                    return;
                }

                const items = (data && Array.isArray(data.results) ? data.results : []).filter(keep);
                if (!items.length) {
                    section.remove();
                    return;
                }

                container.innerHTML = items.map(function (item) { return cardHtml(item, true); }).join('');
                container.setAttribute('data-page', '1');
                container.setAttribute('data-pages', String(Math.min((data && data.totalPages) || 1, 5)));
                loadImages(container);
                container.addEventListener('scroll', function () { maybeExtendRow(row, container, keep, token); }, { passive: true });
            }).catch(function (error) {
                if (token !== renderToken) {
                    return;
                }

                section.remove();
                throw error;
            });
        });

        return Promise.all(loads.map(function (load) { return load.then(function () { return null; }, function (error) { return error; }); }))
            .then(function (errors) {
                if (token !== renderToken) {
                    return;
                }

                const failures = errors.filter(Boolean);
                if (failures.length === DISCOVER_ROWS.length) {
                    view.innerHTML = errorHtml(failures[0]);
                } else if (failures.length) {
                    toastError(failures[0]);
                }
            });
    }

    // Rows load their next page as the user scrolls near the end, up to five pages.
    function maybeExtendRow(row, container, keep, token) {
        const page = Number(container.getAttribute('data-page')) || 1;
        const pages = Number(container.getAttribute('data-pages')) || 1;
        if (container.getAttribute('data-loading') || page >= pages
            || container.scrollLeft + container.clientWidth < container.scrollWidth - 600) {
            return;
        }

        container.setAttribute('data-loading', '1');
        loadDiscoverPage(row, page + 1).then(function (data) {
            if (token !== renderToken) {
                return;
            }

            const seen = {};
            container.querySelectorAll('.card').forEach(function (card) {
                seen[card.getAttribute('data-media-type') + ':' + card.getAttribute('data-id')] = true;
            });
            const items = (data && Array.isArray(data.results) ? data.results : []).filter(keep)
                .filter(function (item) { return !seen[item.mediaType + ':' + item.id]; });
            container.insertAdjacentHTML('beforeend', items.map(function (item) { return cardHtml(item, true); }).join(''));
            container.setAttribute('data-page', String(page + 1));
            loadImages(container);
        }).catch(function () {
            container.setAttribute('data-pages', String(page));
        }).then(function () {
            container.removeAttribute('data-loading');
        });
    }

    function renderSearch(view, route, token) {
        let page = 1;
        let pages = 1;
        let shown = 0;
        view.innerHTML = '<section class="verticalSection sui-section">'
            + '<h2 class="sectionTitle sectionTitle-cards">Results for “' + escapeHtml(route.query) + '”</h2>'
            + '<div class="itemsContainer vertical-wrap sui-grid"></div>'
            + '<div class="sui-more"></div>'
            + '</section>';
        const grid = view.querySelector('.sui-grid');
        const more = view.querySelector('.sui-more');

        function load() {
            more.innerHTML = loadingHtml();
            return api.get('search', { query: route.query, page: page }).then(function (data) {
                if (token !== renderToken) {
                    return;
                }

                pages = (data && data.totalPages) || 1;
                const items = (data && Array.isArray(data.results) ? data.results : []).filter(isMediaResult);
                shown += items.length;
                grid.insertAdjacentHTML('beforeend', items.map(function (item) { return cardHtml(item, false); }).join(''));
                loadImages(grid);
                if (!shown && page >= pages) {
                    view.innerHTML = messageHtml('search_off', 'Nothing found', 'No movies or series match “' + route.query + '”.', false);
                    return;
                }

                more.innerHTML = page < pages
                    ? '<button type="button" class="sui-btn" data-action="more">Show more</button>'
                    : '';
                const button = more.querySelector('button');
                if (button) {
                    button.addEventListener('click', function () {
                        page++;
                        load().catch(function (error) {
                            if (token === renderToken) {
                                more.innerHTML = '';
                                toastError(error);
                            }
                        });
                    });
                }
            });
        }

        return load();
    }

    function factsFor(details, mediaType) {
        const facts = [];
        const year = yearOf(details);
        if (year) {
            facts.push(year);
        }

        if (mediaType === 'movie' && details.runtime > 0) {
            const hours = Math.floor(details.runtime / 60);
            const minutes = details.runtime % 60;
            facts.push((hours ? hours + 'h ' : '') + minutes + 'm');
        }

        if (mediaType === 'tv' && details.numberOfSeasons > 0) {
            facts.push(details.numberOfSeasons + (details.numberOfSeasons === 1 ? ' season' : ' seasons'));
        }

        if (Array.isArray(details.genres) && details.genres.length) {
            facts.push(details.genres.slice(0, 3).map(function (genre) { return genre.name; }).join(', '));
        }

        if (details.voteAverage > 0) {
            facts.push('★ ' + Number(details.voteAverage).toFixed(1));
        }

        return facts.join(' · ');
    }

    const STATE_CHIPS = {
        available: ['available', 'Available', 'check_circle'],
        partial: ['partial', 'Partially available', 'incomplete_circle'],
        processing: ['processing', 'Requested', 'schedule'],
        pending: ['pending', 'Pending approval', 'hourglass_empty'],
        failed: ['failed', 'Failed', 'error_outline'],
        blocked: ['blocked', 'Blocklisted', 'block'],
        requestable: ['unknown', 'Not requested', '']
    };

    function stateChip(state, prefix) {
        const chip = STATE_CHIPS[state];
        return chip ? chipHtml(chip[0], (prefix ? prefix + ': ' : '') + chip[1], chip[2]) : '';
    }

    function actionButtonsHtml(mediaType, details, current) {
        const me = current.me;
        const settings = current.settings || {};
        const parts = [];
        const notes = [];
        const jellyfinId = details.mediaInfo && (details.mediaInfo.jellyfinMediaId || details.mediaInfo.jellyfinMediaId4k);
        if (jellyfinId && /^[0-9a-fA-F-]{32,36}$/.test(jellyfinId)) {
            parts.push('<button type="button" class="sui-btn sui-btn-primary" data-action="open-item" data-item-id="' + escapeHtml(jellyfinId) + '"><span class="material-icons" aria-hidden="true">play_arrow</span>View in library</button>');
        }

        const variants = [false];
        if (is4kEnabled(settings, mediaType) && canRequest(me, mediaType, true)) {
            variants.push(true);
        }

        variants.forEach(function (is4k) {
            const prefix = variants.length > 1 ? (is4k ? '4K' : 'Standard') : '';
            const label = is4k ? 'Request in 4K' : 'Request';
            if (mediaType === 'movie') {
                const result = movieRequestState(details, me, is4k);
                if (result.state === 'requestable') {
                    parts.push('<button type="button" class="sui-btn' + (jellyfinId || is4k ? '' : ' sui-btn-primary') + '" data-action="request-movie" data-4k="' + is4k + '"><span class="material-icons" aria-hidden="true">add</span>' + label + '</button>');
                } else if (result.state === 'forbidden') {
                    notes.push('Your Seerr account cannot request movies' + (is4k ? ' in 4K' : '') + '.');
                } else {
                    parts.push(stateChip(result.state, prefix));
                    if (result.own) {
                        parts.push('<button type="button" class="sui-btn sui-btn-danger" data-action="cancel-request" data-request-id="' + result.own.id + '"><span class="material-icons" aria-hidden="true">close</span>Cancel request</button>');
                    }
                }

                return;
            }

            const result = seriesRequestState(details, me, settings, is4k);
            if (result.state === 'requestable') {
                const anyRequested = seasonsOf(details, settings).length > result.open.length;
                parts.push('<button type="button" class="sui-btn' + (jellyfinId || is4k ? '' : ' sui-btn-primary') + '" data-action="request-tv" data-4k="' + is4k + '"><span class="material-icons" aria-hidden="true">add</span>' + (anyRequested ? (is4k ? 'Request more in 4K' : 'Request more') : label) + '</button>');
            } else if (result.state === 'forbidden') {
                notes.push('Your Seerr account cannot request series' + (is4k ? ' in 4K' : '') + '.');
            } else {
                parts.push(stateChip(result.state, prefix));
            }

            const own = ownPendingRequest(me, details.mediaInfo, is4k);
            if (own) {
                parts.push('<button type="button" class="sui-btn" data-action="edit-request" data-request-id="' + own.id + '" data-4k="' + is4k + '"><span class="material-icons" aria-hidden="true">edit</span>Edit request' + (is4k && variants.length > 1 ? ' (4K)' : '') + '</button>');
                parts.push('<button type="button" class="sui-btn sui-btn-danger" data-action="cancel-request" data-request-id="' + own.id + '"><span class="material-icons" aria-hidden="true">close</span>Cancel request' + (is4k && variants.length > 1 ? ' (4K)' : '') + '</button>');
            }
        });

        const lines = [];
        variants.forEach(function (is4k) {
            const suffix = variants.length > 1 && is4k ? ' in 4K' : '';
            const holders = requestHolders(details.mediaInfo, me, is4k);
            if (holders.own.length) {
                const approved = holders.own.some(function (request) { return request.status === RequestStatus.APPROVED; });
                const pending = holders.own.some(function (request) { return request.status === RequestStatus.PENDING; });
                lines.push(noteHtml(pending
                    ? 'You requested this' + suffix + '. It is waiting for approval.'
                    : approved && !canManageRequests(me)
                        ? 'You requested this' + suffix + '. It is approved, so only a server admin can withdraw it now.'
                        : 'You requested this' + suffix + '.'));
            }

            if (holders.others.length) {
                lines.push(noteHtml(holders.names.length
                    ? 'Requested' + suffix + ' by ' + joinNames(holders.names) + '.'
                    : (holders.own.length ? 'Someone else requested this' : 'Already requested by someone else') + suffix + '.'));
            }

            const progress = downloadProgress(details.mediaInfo, is4k);
            if (progress) {
                lines.push(progressHtml(progress, mediaType, suffix));
            }
        });

        return '<div class="sui-actions">' + parts.join('') + '</div>'
            + notes.map(noteHtml).join('')
            + lines.join('');
    }

    function noteHtml(text) {
        return '<div class="sui-note">' + escapeHtml(text) + '</div>';
    }

    function joinNames(names) {
        return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    }

    function progressHtml(progress, mediaType, suffix) {
        const parts = [progress.count > 1 && mediaType === 'tv' ? 'Downloading ' + progress.count + ' episodes' : 'Downloading'];
        if (progress.percent !== null) {
            parts.push(progress.percent + '%');
        }

        const left = formatTimeLeft(progress.eta, Date.now());
        if (left) {
            parts.push(left);
        }

        const label = parts.join(' · ') + suffix;
        const percent = progress.percent === null ? 0 : progress.percent;
        return '<div class="sui-progress">'
            + '<div class="sui-progress-label"><span>' + escapeHtml(label) + '</span>'
            + '<button type="button" class="sui-btn sui-btn-small" data-action="refresh"><span class="material-icons" aria-hidden="true">refresh</span>Refresh</button></div>'
            + '<div class="sui-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '" aria-label="' + escapeHtml(label) + '">'
            + '<div class="sui-progress-bar" style="width:' + percent + '%"></div></div>'
            + '</div>';
    }

    function seasonListHtml(details, current) {
        const settings = current.settings || {};
        const seasons = seasonsOf(details, settings);
        if (!seasons.length) {
            return '';
        }

        const show4k = is4kEnabled(settings, 'tv') && canRequest(current.me, 'tv', true);
        return '<section class="sui-seasons">'
            + '<h2 class="sectionTitle">Seasons</h2>'
            + seasons.map(function (season) {
                const name = season.name || ('Season ' + season.seasonNumber);
                const episodes = season.episodeCount ? season.episodeCount + (season.episodeCount === 1 ? ' episode' : ' episodes') : '';
                return '<div class="sui-season">'
                    + '<div><div>' + escapeHtml(name) + '</div><div class="sui-muted">' + escapeHtml([episodes, yearOf({ releaseDate: season.airDate })].filter(Boolean).join(' · ')) + '</div></div>'
                    + '<div class="sui-actions" style="margin:0">' + stateChip(seasonState(details, season.seasonNumber, false), show4k ? 'Standard' : '')
                    + (show4k ? stateChip(seasonState(details, season.seasonNumber, true), '4K') : '') + '</div>'
                    + '</div>';
            }).join('')
            + '</section>';
    }

    function renderDetails(view, route, current, token) {
        const mediaType = route.view;
        return getDetails(mediaType, route.id, true).then(function (details) {
            if (token !== renderToken) {
                return;
            }

            const title = titleOf(details);
            const poster = imageUrl(details.posterPath, 'w500');
            setBackdrop(view.closest('#' + PAGE_ID), imageUrl(details.backdropPath, 'w1280'));
            view.innerHTML = '<div class="sui-details" data-media-type="' + mediaType + '" data-id="' + details.id + '">'
                + '<div class="sui-details-main">'
                + (poster
                    ? '<div class="sui-details-poster" role="img" aria-label="' + escapeHtml(title) + '" style="background-image:url(&quot;' + escapeHtml(poster) + '&quot;)"></div>'
                    : '<div class="sui-details-poster defaultCardBackground defaultCardBackground1"></div>')
                + '<div class="sui-details-info">'
                + '<h1 class="sui-details-title">' + escapeHtml(title) + '</h1>'
                + '<div class="sui-details-facts">' + escapeHtml(factsFor(details, mediaType)) + '</div>'
                + actionButtonsHtml(mediaType, details, current)
                + (details.tagline ? '<p class="sui-details-tagline">' + escapeHtml(details.tagline) + '</p>' : '')
                + '<p class="sui-details-overview">' + escapeHtml(details.overview || 'No overview available.') + '</p>'
                + '</div>'
                + '</div>'
                + (mediaType === 'tv' ? seasonListHtml(details, current) : '')
                + '<section class="verticalSection sui-section" data-row="recommendations" hidden>'
                + '<h2 class="sectionTitle sectionTitle-cards">More like this</h2>'
                + '<div class="itemsContainer scrollX hiddenScrollX sui-row"></div>'
                + '</section>'
                + '</div>';
            view.__details = details;

            api.get(mediaType + '/' + details.id + '/recommendations', { page: 1 }).then(function (data) {
                if (token !== renderToken) {
                    return;
                }

                const items = (data && Array.isArray(data.results) ? data.results : [])
                    .map(function (item) { return item.mediaType ? item : Object.assign({ mediaType: mediaType }, item); })
                    .filter(isMediaResult);
                const section = view.querySelector('[data-row="recommendations"]');
                if (items.length && section) {
                    const container = section.querySelector('.sui-row');
                    container.innerHTML = items.map(function (item) { return cardHtml(item, true); }).join('');
                    section.hidden = false;
                    loadImages(container);
                }
            }).catch(function () {
                // Recommendations are a nicety; the page is complete without them.
            });
        });
    }

    function requestRowHtml(request, current) {
        const media = request.media || {};
        const mediaType = request.type === 'tv' ? 'tv' : 'movie';
        const status = requestStatusLabel(request);
        const meta = [chipHtml(status.kind, status.label)];
        if (request.is4k) {
            meta.push(chipHtml('unknown', '4K'));
        }

        const created = request.createdAt ? new Date(request.createdAt) : null;
        if (created && !isNaN(created.getTime())) {
            meta.push('<span>Requested ' + escapeHtml(created.toLocaleDateString()) + '</span>');
        }

        if (!isOwnRequest(current.me, request) && request.requestedBy) {
            meta.push('<span>by ' + escapeHtml(request.requestedBy.displayName || 'another user') + '</span>');
        }

        if (mediaType === 'tv' && Array.isArray(request.seasons) && request.seasons.length) {
            const numbers = request.seasons.map(function (season) { return season.seasonNumber; }).sort(function (a, b) { return a - b; });
            meta.push('<span>' + (numbers.length === 1 ? 'Season ' : 'Seasons ') + escapeHtml(numbers.join(', ')) + '</span>');
        }

        const actions = [];
        if (canEditRequest(current.me, request)) {
            actions.push('<button type="button" class="sui-btn sui-btn-small" data-action="edit-request" data-request-id="' + request.id + '" data-tmdb-id="' + media.tmdbId + '" data-4k="' + !!request.is4k + '"><span class="material-icons" aria-hidden="true">edit</span>Edit</button>');
        }

        if (canCancelRequest(current.me, request)) {
            actions.push('<button type="button" class="sui-btn sui-btn-small sui-btn-danger" data-action="cancel-request" data-request-id="' + request.id + '"><span class="material-icons" aria-hidden="true">close</span>Cancel</button>');
        } else if (request.status === RequestStatus.APPROVED && isOwnRequest(current.me, request) && !canManageRequests(current.me)) {
            actions.push('<span class="sui-note">Approved, so only a server admin can withdraw it.</span>');
        }

        const progress = request.status === RequestStatus.APPROVED ? downloadProgress(media, request.is4k) : null;
        const href = media.tmdbId ? routeHash({ view: mediaType, id: media.tmdbId }) : '';
        return '<div class="sui-request-row" data-request-id="' + request.id + '" data-media-type="' + mediaType + '" data-tmdb-id="' + (media.tmdbId || '') + '">'
            + (href ? '<a class="sui-request-poster" href="' + escapeHtml(href) + '" aria-hidden="true" tabindex="-1"></a>' : '<div class="sui-request-poster"></div>')
            + '<div class="sui-request-body">'
            + (href ? '<a class="sui-request-title" href="' + escapeHtml(href) + '">' : '<span class="sui-request-title">')
            + '<span class="sui-request-name">' + (mediaType === 'tv' ? 'Series' : 'Movie') + '</span>'
            + (href ? '</a>' : '</span>')
            + '<div class="sui-request-meta">' + meta.join('') + '</div>'
            + (progress ? progressHtml(progress, mediaType, '') : '')
            + (actions.length ? '<div class="sui-request-actions">' + actions.join('') + '</div>' : '')
            + '</div>'
            + '</div>';
    }

    // The request list carries ids only; titles and posters come from each title's details,
    // a few at a time and cached, so a page of requests stays well inside the proxy's limit.
    function fillRequestRows(container, token) {
        const rows = Array.prototype.slice.call(container.querySelectorAll('.sui-request-row:not([data-filled])'));
        let index = 0;
        function next() {
            if (token !== renderToken || index >= rows.length) {
                return Promise.resolve();
            }

            const row = rows[index++];
            row.setAttribute('data-filled', '1');
            const id = positiveInt(row.getAttribute('data-tmdb-id'));
            if (!id) {
                return next();
            }

            return getDetails(row.getAttribute('data-media-type'), id, false).then(function (details) {
                if (token !== renderToken) {
                    return;
                }

                const year = yearOf(details);
                row.querySelector('.sui-request-name').textContent = titleOf(details) + (year ? ' (' + year + ')' : '');
                const poster = imageUrl(details.posterPath, 'w185');
                if (poster) {
                    row.querySelector('.sui-request-poster').style.backgroundImage = 'url("' + poster + '")';
                }
            }, function () {
                // Keep the row with its generic label; the request itself is still shown.
            }).then(next);
        }

        return Promise.all([next(), next(), next()]);
    }

    function renderRequests(view, route, current, token) {
        let page = 0;
        let pages = 1;
        view.innerHTML = '<div class="sui-filters" role="group" aria-label="Filter requests">'
            + REQUEST_FILTERS.map(function (filter) {
                const active = filter.id === route.filter;
                return '<a class="sui-tab' + (active ? ' sui-tab-active' : '') + '" href="' + routeHash({ view: 'requests', filter: filter.id }) + '"' + (active ? ' aria-current="true"' : '') + '>' + escapeHtml(filter.label) + '</a>';
            }).join('')
            + '</div>'
            + '<div class="sui-request-list"></div>'
            + '<div class="sui-more"></div>';
        const list = view.querySelector('.sui-request-list');
        const more = view.querySelector('.sui-more');

        function load() {
            more.innerHTML = loadingHtml();
            return api.get('request', {
                take: REQUESTS_PAGE_SIZE,
                skip: page * REQUESTS_PAGE_SIZE,
                filter: route.filter,
                sort: 'added',
                sortDirection: 'desc'
            }).then(function (data) {
                if (token !== renderToken) {
                    return;
                }

                const results = data && Array.isArray(data.results) ? data.results : [];
                pages = (data && data.pageInfo && data.pageInfo.pages) || 1;
                page++;
                if (!results.length && page === 1) {
                    list.innerHTML = messageHtml('inbox', 'No requests here', route.filter === 'all'
                        ? 'Requests you make from Discover show up here.'
                        : 'Nothing matches this filter right now.', false);
                    more.innerHTML = '';
                    return;
                }

                list.insertAdjacentHTML('beforeend', results.map(function (request) { return requestRowHtml(request, current); }).join(''));
                more.innerHTML = page < pages ? '<button type="button" class="sui-btn">Show more</button>' : '';
                const button = more.querySelector('button');
                if (button) {
                    button.addEventListener('click', function () {
                        load().catch(function (error) {
                            if (token === renderToken) {
                                more.innerHTML = '';
                                toastError(error);
                            }
                        });
                    });
                }

                return fillRequestRows(list, token);
            });
        }

        return load();
    }

    // ---------------------------------------------------------------------------------
    // Dialogs.
    // ---------------------------------------------------------------------------------

    function closeLayers() {
        document.querySelectorAll('.sui-layer').forEach(function (layer) {
            if (typeof layer.__close === 'function') {
                layer.__close(null);
            } else {
                layer.remove();
            }
        });
    }

    // Resolves with the clicked action, or null when dismissed.
    function openDialog(html, setup) {
        return new Promise(function (resolve) {
            const previousFocus = document.activeElement;
            const layer = document.createElement('div');
            layer.className = 'sui-layer';
            layer.innerHTML = '<div class="sui-dialog" role="dialog" aria-modal="true" tabindex="-1">' + html + '</div>';
            const dialog = layer.firstChild;

            function close(result) {
                document.removeEventListener('keydown', onKey, true);
                layer.remove();
                if (previousFocus && typeof previousFocus.focus === 'function') {
                    previousFocus.focus();
                }

                resolve(result);
            }

            function onKey(event) {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    close(null);
                }
            }

            layer.__close = close;
            layer.addEventListener('click', function (event) {
                if (event.target === layer) {
                    close(null);
                    return;
                }

                const button = event.target.closest('[data-dialog-action]');
                if (button && !button.disabled) {
                    close(button.getAttribute('data-dialog-action') === 'cancel' ? null : button.getAttribute('data-dialog-action'));
                }
            });
            document.addEventListener('keydown', onKey, true);
            document.body.appendChild(layer);
            if (setup) {
                setup(dialog);
            }

            const first = dialog.querySelector('input:not([disabled]), button[data-dialog-action="confirm"]');
            (first || dialog).focus();
        });
    }

    function confirmDialog(title, text, confirmLabel) {
        return openDialog('<h2>' + escapeHtml(title) + '</h2><p>' + escapeHtml(text) + '</p>'
            + '<div class="sui-dialog-actions">'
            + '<button type="button" class="sui-btn" data-dialog-action="cancel">Keep it</button>'
            + '<button type="button" class="sui-btn sui-btn-danger" data-dialog-action="confirm">' + escapeHtml(confirmLabel) + '</button>'
            + '</div>').then(function (result) { return result === 'confirm'; });
    }

    // Season picker for a new request, or for editing a pending one. Resolves with the
    // season numbers to send, or null.
    function seasonDialog(details, current, is4k, editing) {
        const settings = current.settings || {};
        const partial = settings.partialRequestsEnabled !== false;
        const open = requestableSeasons(details, settings, is4k);
        const held = editing ? editing.seasons.map(function (season) { return season.seasonNumber; }) : [];
        const editable = open.concat(held);
        const seasons = seasonsOf(details, settings);
        const title = titleOf(details);
        const heading = (editing ? 'Edit request: ' : 'Request ') + title + (is4k ? ' in 4K' : '');
        const intro = partial
            ? 'Choose the seasons to request.'
            : 'This server requests every remaining season together.';

        const rows = seasons.map(function (season) {
            const number = season.seasonNumber;
            const isEditable = partial && editable.indexOf(number) !== -1;
            const checked = held.indexOf(number) !== -1 || (!partial && open.indexOf(number) !== -1);
            const state = held.indexOf(number) !== -1 ? 'pending' : seasonState(details, number, is4k);
            const name = season.name || ('Season ' + number);
            const episodes = season.episodeCount ? season.episodeCount + (season.episodeCount === 1 ? ' episode' : ' episodes') : '';
            const locked = !isEditable;
            return '<label class="sui-dialog-item' + (locked ? ' sui-locked' : '') + '">'
                + '<input type="checkbox" value="' + number + '"' + (checked || (locked && state !== 'requestable') ? ' checked' : '') + (locked ? ' disabled' : '') + '>'
                + '<span class="sui-dialog-item-text">' + escapeHtml(name) + (episodes ? '<small>' + escapeHtml(episodes) + '</small>' : '') + '</span>'
                + (state !== 'requestable' && held.indexOf(number) === -1 ? stateChip(state) : '')
                + '</label>';
        }).join('');

        let chosen = null;
        return openDialog('<h2>' + escapeHtml(heading) + '</h2><p>' + escapeHtml(intro) + '</p>'
            + (partial && editable.length > 1 ? '<label class="sui-dialog-item"><input type="checkbox" data-select-all><span class="sui-dialog-item-text">Select all</span></label>' : '')
            + '<div class="sui-dialog-list">' + rows + '</div>'
            + '<div class="sui-dialog-actions">'
            + '<button type="button" class="sui-btn" data-dialog-action="cancel">Cancel</button>'
            + '<button type="button" class="sui-btn sui-btn-primary" data-dialog-action="confirm"></button>'
            + '</div>', function (dialog) {
            const confirm = dialog.querySelector('[data-dialog-action="confirm"]');
            const all = dialog.querySelector('[data-select-all]');
            const boxes = Array.prototype.slice.call(dialog.querySelectorAll('.sui-dialog-list input:not([disabled])'));

            function update() {
                const selected = boxes.filter(function (box) { return box.checked; }).map(function (box) { return Number(box.value); });
                chosen = editing
                    ? selected.sort(function (a, b) { return a - b; })
                    : seasonsToSubmit(selected, open, partial);
                const count = chosen.length;
                confirm.disabled = count === 0;
                confirm.textContent = editing
                    ? (count ? 'Save ' + count + (count === 1 ? ' season' : ' seasons') : 'Choose at least one season')
                    : (count ? 'Request ' + count + (count === 1 ? ' season' : ' seasons') : 'Choose seasons');
                if (all) {
                    all.checked = boxes.length > 0 && boxes.every(function (box) { return box.checked; });
                }
            }

            if (all) {
                all.addEventListener('change', function () {
                    boxes.forEach(function (box) { box.checked = all.checked; });
                    update();
                });
            }

            boxes.forEach(function (box) { box.addEventListener('change', update); });
            update();
        }).then(function (result) {
            return result === 'confirm' && chosen && chosen.length ? chosen : null;
        });
    }

    // ---------------------------------------------------------------------------------
    // Actions.
    // ---------------------------------------------------------------------------------

    function currentDetails(page) {
        const view = page.querySelector('.sui-view');
        return view && view.__details ? view.__details : null;
    }

    function rerender(page) {
        if (currentRoute) {
            renderRoute(page, currentRoute, true);
        }
    }

    function afterChange(page, mediaType, tmdbId, message) {
        forgetMedia(mediaType, tmdbId);
        toast(message);
        rerender(page);
    }

    function submitRequest(page, mediaType, is4k, button) {
        const details = currentDetails(page);
        if (!details || !session) {
            return;
        }

        const pick = mediaType === 'tv'
            ? seasonDialog(details, session, is4k, null)
            : Promise.resolve([]);
        pick.then(function (seasons) {
            if (!seasons) {
                return null;
            }

            button.disabled = true;
            return api.post('request', buildRequestBody(mediaType, details, is4k, seasons)).then(function (result) {
                if (result && result.accepted) {
                    afterChange(page, mediaType, details.id, (result.data && result.data.message) || 'Those seasons are already requested.');
                    return;
                }

                const approved = result && result.status === RequestStatus.APPROVED;
                afterChange(page, mediaType, details.id, approved
                    ? 'Requested ' + titleOf(details) + '. It was approved automatically.'
                    : 'Requested ' + titleOf(details) + '. It is waiting for approval.');
            });
        }).catch(function (error) {
            button.disabled = false;
            toastError(error);
        });
    }

    function findRequest(details, requestId) {
        const requests = details && details.mediaInfo && Array.isArray(details.mediaInfo.requests) ? details.mediaInfo.requests : [];
        return requests.filter(function (request) { return request.id === requestId; })[0] || null;
    }

    function cancelRequest(page, requestId, button) {
        const row = button.closest('.sui-request-row');
        const details = row ? null : currentDetails(page);
        const mediaType = row ? row.getAttribute('data-media-type') : (details && details.seasons ? 'tv' : 'movie');
        const tmdbId = row ? positiveInt(row.getAttribute('data-tmdb-id')) : details && details.id;
        const name = row ? row.querySelector('.sui-request-name').textContent : titleOf(details);
        confirmDialog('Cancel this request?', 'The request for ' + name + ' will be withdrawn from Seerr.', 'Cancel request').then(function (confirmed) {
            if (!confirmed) {
                return null;
            }

            button.disabled = true;
            return api.remove('request/' + requestId).then(function () {
                afterChange(page, mediaType, tmdbId, 'Request cancelled.');
            });
        }).catch(function (error) {
            button.disabled = false;
            toastError(error);
        });
    }

    function editRequest(page, requestId, is4k, button) {
        const row = button.closest('.sui-request-row');
        const tmdbId = row ? positiveInt(row.getAttribute('data-tmdb-id')) : null;
        const detailsPromise = row && tmdbId ? getDetails('tv', tmdbId, true) : Promise.resolve(currentDetails(page));
        button.disabled = true;
        detailsPromise.then(function (details) {
            button.disabled = false;
            const request = findRequest(details, requestId);
            if (!details || !request || !canEditRequest(session && session.me, Object.assign({ type: 'tv' }, request))) {
                toast('This request can no longer be changed.');
                rerender(page);
                return null;
            }

            return seasonDialog(details, session, is4k, request).then(function (seasons) {
                if (!seasons) {
                    return null;
                }

                button.disabled = true;
                return api.put('request/' + requestId, { mediaType: 'tv', seasons: seasons }).then(function () {
                    afterChange(page, 'tv', details.id, 'Request updated.');
                });
            });
        }).catch(function (error) {
            button.disabled = false;
            toastError(error);
        });
    }

    function bindPage(page) {
        page.querySelector('.sui-search').addEventListener('submit', function (event) {
            event.preventDefault();
            const query = event.target.elements.q.value.trim();
            if (query) {
                navigate({ view: 'search', query: query.slice(0, 200) }, currentRoute && currentRoute.view === 'search');
            }
        });

        let typing = 0;
        page.querySelector('.sui-search input').addEventListener('input', function (event) {
            const input = event.target;
            clearTimeout(typing);
            typing = setTimeout(function () {
                const query = input.value.trim();
                if (query.length >= 2) {
                    // Typing refines one search rather than leaving a history entry per key.
                    navigate({ view: 'search', query: query.slice(0, 200) }, currentRoute && currentRoute.view === 'search');
                } else if (!query && currentRoute && currentRoute.view === 'search') {
                    navigate({ view: 'discover' }, true);
                }
            }, 450);
        });

        page.addEventListener('click', function (event) {
            const target = event.target.closest('[data-action]');
            if (!target || !page.contains(target)) {
                return;
            }

            const action = target.getAttribute('data-action');
            const is4k = target.getAttribute('data-4k') === 'true';
            const requestId = positiveInt(target.getAttribute('data-request-id'));
            switch (action) {
                case 'retry':
                    session = null;
                    rerender(page);
                    break;
                case 'refresh':
                    rerender(page);
                    break;
                case 'scroll-row': {
                    const row = target.parentNode.querySelector('.sui-row');
                    row.scrollBy({ left: Number(target.getAttribute('data-direction')) * row.clientWidth * 0.8, behavior: 'smooth' });
                    break;
                }
                case 'request-movie':
                    submitRequest(page, 'movie', is4k, target);
                    break;
                case 'request-tv':
                    submitRequest(page, 'tv', is4k, target);
                    break;
                case 'cancel-request':
                    if (requestId) {
                        cancelRequest(page, requestId, target);
                    }

                    break;
                case 'edit-request':
                    if (requestId) {
                        editRequest(page, requestId, is4k, target);
                    }

                    break;
                case 'open-item': {
                    const itemId = target.getAttribute('data-item-id');
                    if (window.Emby && window.Emby.Page && typeof window.Emby.Page.showItem === 'function') {
                        window.Emby.Page.showItem(itemId);
                    }

                    break;
                }
                default:
                    break;
            }
        });
    }

    // ---------------------------------------------------------------------------------
    // Start.
    // ---------------------------------------------------------------------------------

    function start() {
        injectStyles();
        window.addEventListener('hashchange', onLocationChange);
        window.addEventListener('popstate', onLocationChange);
        new MutationObserver(queueNav).observe(document.body, { childList: true, subtree: true });
        // Another page shown by Jellyfin always wins over this one.
        document.addEventListener('viewshow', function (event) {
            if (currentRoute && event.target && event.target.id !== PAGE_ID && !parseRoute(window.location.hash)) {
                hidePage();
            }
        });
        // Jellyfin Web's not-found page announces itself when it mounts, which can land after
        // this page did. While the route is still this page's, announce again so the header
        // keeps this page's title.
        document.addEventListener('pageshow', function (event) {
            if (currentRoute && event.target && event.target.id !== PAGE_ID && parseRoute(window.location.hash)) {
                setTimeout(function () {
                    const page = document.getElementById(PAGE_ID);
                    if (currentRoute && page && !page.classList.contains('hide')) {
                        announce(page);
                    }
                }, 0);
            }
        });
        queueNav();
        onLocationChange();
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }
})();
