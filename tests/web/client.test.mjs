// Unit tests for the Requests page's model and proxy client. No dependencies: `node --test`.
//
// The page is loaded the way the browser loads it, as one script, into a sandbox that only
// has what the model needs. Values crossing back out of the sandbox are copied into this
// realm with `plain`, since deepStrictEqual compares prototypes.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../Web/seerr-integration.js'), 'utf8');

function load() {
    const window = { __seerrIntegrationNoInit: true };
    const document = { currentScript: { src: 'http://jf/Plugins/SeerrIntegration/Client/seerr-integration.js?v=1.0.0.7' } };
    vm.runInNewContext(SOURCE, { window, document, URLSearchParams, console });
    return window.SeerrIntegration;
}

const { version, model } = load();
const { Permission: P, MediaStatus: M, RequestStatus: R } = model;
const plain = value => JSON.parse(JSON.stringify(value));

const user = (id, permissions) => ({ id, permissions });
const request = (overrides) => Object.assign({ id: 10, status: R.PENDING, type: 'movie', is4k: false, requestedBy: { id: 1 } }, overrides);

test('reads its own version from the script URL', () => {
    assert.equal(version, '1.0.0.7');
});

test('hasPermission mirrors Seerr: admin holds everything, lists are all-of unless or', () => {
    assert.equal(model.hasPermission(P.ADMIN, P.MANAGE_REQUESTS), true);
    assert.equal(model.hasPermission(P.REQUEST, P.REQUEST), true);
    assert.equal(model.hasPermission(P.REQUEST, P.MANAGE_REQUESTS), false);
    assert.equal(model.hasPermission(P.REQUEST, [P.REQUEST, P.REQUEST_4K]), false);
    assert.equal(model.hasPermission(P.REQUEST, [P.REQUEST, P.REQUEST_4K], 'or'), true);
    assert.equal(model.hasPermission(0, P.NONE), true);
    assert.equal(model.hasPermission(undefined, P.REQUEST), false);
});

test('canRequest follows the general and per-type request permissions', () => {
    assert.equal(model.canRequest(user(1, P.REQUEST), 'movie', false), true);
    assert.equal(model.canRequest(user(1, P.REQUEST), 'tv', false), true);
    assert.equal(model.canRequest(user(1, P.REQUEST_MOVIE), 'movie', false), true);
    assert.equal(model.canRequest(user(1, P.REQUEST_MOVIE), 'tv', false), false);
    assert.equal(model.canRequest(user(1, P.REQUEST_TV), 'tv', false), true);
    assert.equal(model.canRequest(user(1, P.REQUEST), 'movie', true), false);
    assert.equal(model.canRequest(user(1, P.REQUEST_4K_MOVIE), 'movie', true), true);
    assert.equal(model.canRequest(user(1, P.REQUEST_4K_MOVIE), 'tv', true), false);
    assert.equal(model.canRequest(user(1, P.ADMIN), 'tv', true), true);
    assert.equal(model.canRequest(user(1, 0), 'movie', false), false);
    assert.equal(model.canRequest(null, 'movie', false), false);
});

test('is4kEnabled reads the server setting for the media type', () => {
    assert.equal(model.is4kEnabled({ movie4kEnabled: true }, 'movie'), true);
    assert.equal(model.is4kEnabled({ movie4kEnabled: true }, 'tv'), false);
    assert.equal(model.is4kEnabled({ series4kEnabled: true }, 'tv'), true);
    assert.equal(model.is4kEnabled(null, 'tv'), false);
});

test('cancelling: owners may withdraw pending requests, managers any pending request', () => {
    const me = user(1, P.REQUEST);
    assert.equal(model.canCancelRequest(me, request({})), true);
    assert.equal(model.canCancelRequest(me, request({ status: R.APPROVED })), false);
    assert.equal(model.canCancelRequest(me, request({ requestedBy: { id: 2 } })), false);
    assert.equal(model.canCancelRequest(user(5, P.MANAGE_REQUESTS), request({ requestedBy: { id: 2 } })), true);
    assert.equal(model.canCancelRequest(me, null), false);
});

test('editing: only pending series requests, for the owner or a manager', () => {
    const me = user(1, P.REQUEST);
    assert.equal(model.canEditRequest(me, request({ type: 'tv' })), true);
    assert.equal(model.canEditRequest(me, request({ type: 'movie' })), false);
    assert.equal(model.canEditRequest(me, request({ type: 'tv', status: R.DECLINED })), false);
    assert.equal(model.canEditRequest(me, request({ type: 'tv', requestedBy: { id: 3 } })), false);
});

test('seesOtherUsersRequests matches Seerr list scoping', () => {
    assert.equal(model.seesOtherUsersRequests(user(1, P.REQUEST)), false);
    assert.equal(model.seesOtherUsersRequests(user(1, P.REQUEST_VIEW)), true);
    assert.equal(model.seesOtherUsersRequests(user(1, P.MANAGE_REQUESTS)), true);
    assert.equal(model.seesOtherUsersRequests(user(1, P.ADMIN)), true);
});

test('poster badges show only meaningful states', () => {
    assert.equal(model.badgeFor(null), null);
    assert.equal(model.badgeFor({ status: M.UNKNOWN }), null);
    assert.equal(model.badgeFor({ status: M.DELETED }), null);
    assert.equal(model.badgeFor({ status: M.AVAILABLE }).kind, 'available');
    assert.equal(model.badgeFor({ status: M.PARTIALLY_AVAILABLE }).kind, 'partial');
    assert.equal(model.badgeFor({ status: M.PROCESSING }).kind, 'processing');
    assert.equal(model.badgeFor({ status: M.PENDING }).kind, 'pending');
    assert.equal(model.badgeFor({ status: M.BLOCKLISTED }).kind, 'blocked');
});

test('movie request state', () => {
    const me = user(1, P.REQUEST);
    const movie = mediaInfo => ({ id: 27205, mediaInfo });
    assert.equal(model.movieRequestState(movie(undefined), me, false).state, 'requestable');
    assert.equal(model.movieRequestState(movie({ status: M.DELETED }), me, false).state, 'requestable');
    assert.equal(model.movieRequestState(movie(undefined), user(1, 0), false).state, 'forbidden');
    assert.equal(model.movieRequestState(movie({ status: M.AVAILABLE }), me, false).state, 'available');
    assert.equal(model.movieRequestState(movie({ status: M.PROCESSING }), me, false).state, 'processing');
    assert.equal(model.movieRequestState(movie({ status: M.BLOCKLISTED }), me, false).state, 'blocked');

    const mine = request({ id: 4 });
    const theirs = request({ id: 5, requestedBy: { id: 2 } });
    const pending = model.movieRequestState(movie({ status: M.PENDING, requests: [theirs, mine] }), me, false);
    assert.equal(pending.state, 'pending');
    assert.equal(pending.own.id, 4);
    assert.equal(model.movieRequestState(movie({ status: M.PENDING, requests: [theirs] }), me, false).own, null);

    // The 4K copy has its own status and requests.
    const split = movie({ status: M.AVAILABLE, status4k: M.UNKNOWN, requests: [mine] });
    assert.equal(model.movieRequestState(split, user(1, P.REQUEST | P.REQUEST_4K), true).state, 'requestable');
});

const SERIES = {
    id: 1396,
    externalIds: { tvdbId: 81189 },
    seasons: [
        { seasonNumber: 0, name: 'Specials', episodeCount: 5 },
        { seasonNumber: 3, name: 'Season 3', episodeCount: 13 },
        { seasonNumber: 1, name: 'Season 1', episodeCount: 7 },
        { seasonNumber: 2, name: 'Season 2', episodeCount: 13 }
    ]
};

test('seasonsOf hides specials unless the server enables them, and sorts', () => {
    assert.deepEqual(model.seasonsOf(SERIES, {}).map(season => season.seasonNumber), [1, 2, 3]);
    assert.deepEqual(model.seasonsOf(SERIES, { enableSpecialEpisodes: true }).map(season => season.seasonNumber), [0, 1, 2, 3]);
    assert.deepEqual(plain(model.seasonsOf({}, {})), []);
});

test('season state: availability wins, then any request that is not declined', () => {
    const series = Object.assign({}, SERIES, {
        mediaInfo: {
            status: M.PARTIALLY_AVAILABLE,
            seasons: [{ seasonNumber: 1, status: M.AVAILABLE, status4k: M.UNKNOWN }],
            requests: [
                request({ type: 'tv', status: R.PENDING, seasons: [{ seasonNumber: 2 }] }),
                request({ type: 'tv', status: R.DECLINED, seasons: [{ seasonNumber: 3 }] }),
                request({ type: 'tv', status: R.APPROVED, is4k: true, seasons: [{ seasonNumber: 3 }] })
            ]
        }
    });
    assert.equal(model.seasonState(series, 1, false), 'available');
    assert.equal(model.seasonState(series, 2, false), 'pending');
    assert.equal(model.seasonState(series, 3, false), 'requestable');
    assert.equal(model.seasonState(series, 1, true), 'requestable');
    assert.equal(model.seasonState(series, 3, true), 'processing');
    assert.deepEqual(plain(model.requestableSeasons(series, {}, false)), [3]);

    const failed = Object.assign({}, SERIES, {
        mediaInfo: { requests: [request({ type: 'tv', status: R.FAILED, seasons: [{ seasonNumber: 1 }] })] }
    });
    assert.equal(model.seasonState(failed, 1, false), 'failed');
});

test('series request state', () => {
    const me = user(1, P.REQUEST);
    assert.deepEqual(plain(model.seriesRequestState(SERIES, me, {}, false)), { state: 'requestable', open: [1, 2, 3] });
    assert.equal(model.seriesRequestState(SERIES, user(1, P.REQUEST_MOVIE), {}, false).state, 'forbidden');

    const allAvailable = Object.assign({}, SERIES, {
        mediaInfo: { status: M.AVAILABLE, seasons: [1, 2, 3].map(n => ({ seasonNumber: n, status: M.AVAILABLE })) }
    });
    assert.equal(model.seriesRequestState(allAvailable, me, {}, false).state, 'available');

    const allPending = Object.assign({}, SERIES, {
        mediaInfo: { status: M.PENDING, requests: [request({ type: 'tv', seasons: [1, 2, 3].map(n => ({ seasonNumber: n })) })] }
    });
    assert.equal(model.seriesRequestState(allPending, me, {}, false).state, 'pending');
    assert.equal(model.seriesRequestState(Object.assign({}, SERIES, { mediaInfo: { status: M.BLOCKLISTED } }), me, {}, false).state, 'blocked');
});

test('seasonsToSubmit honours the partial requests setting', () => {
    assert.deepEqual(plain(model.seasonsToSubmit([3, 1], [1, 2, 3], true)), [1, 3]);
    assert.deepEqual(plain(model.seasonsToSubmit([1, 9], [1, 2, 3], true)), [1]);
    assert.deepEqual(plain(model.seasonsToSubmit([1], [1, 2, 3], false)), [1, 2, 3]);
});

test('request bodies carry the media only, never an identity', () => {
    const movieBody = plain(model.buildRequestBody('movie', { id: 27205 }, false, []));
    assert.deepEqual(movieBody, { mediaType: 'movie', mediaId: 27205, is4k: false });

    const tvBody = plain(model.buildRequestBody('tv', SERIES, true, [1, 2]));
    assert.deepEqual(tvBody, { mediaType: 'tv', mediaId: 1396, is4k: true, seasons: [1, 2], tvdbId: 81189 });

    const noTvdb = plain(model.buildRequestBody('tv', { id: 7, externalIds: { tvdbId: null } }, false, [1]));
    assert.equal('tvdbId' in noTvdb, false);

    for (const body of [movieBody, tvBody, noTvdb]) {
        for (const key of ['userId', 'user', 'requestedBy', 'modifiedBy']) {
            assert.equal(key in body, false, key);
        }
    }
});

test('download progress sums whatever is in flight, per copy', () => {
    assert.equal(model.downloadProgress(null, false), null);
    assert.equal(model.downloadProgress({ downloadStatus: [] }, false), null);

    const finish = '2026-11-19T12:30:00.000Z';
    const movie = { downloadStatus: [{ size: 1000, sizeLeft: 250, estimatedCompletionTime: finish }] };
    const progress = model.downloadProgress(movie, false);
    assert.equal(progress.percent, 75);
    assert.equal(progress.count, 1);
    assert.equal(progress.eta.toISOString(), finish);
    assert.equal(model.downloadProgress(movie, true), null);

    const episodes = {
        downloadStatus4k: [
            { size: 300, sizeLeft: 300, estimatedCompletionTime: '2026-11-19T12:00:00Z' },
            { size: 100, sizeLeft: 0, estimatedCompletionTime: '2026-11-19T13:00:00Z' }
        ]
    };
    const both = model.downloadProgress(episodes, true);
    assert.equal(both.percent, 25);
    assert.equal(both.count, 2);
    assert.equal(both.eta.toISOString(), '2026-11-19T13:00:00.000Z');

    // Queued, with no size yet: shown as downloading without a figure.
    assert.equal(model.downloadProgress({ downloadStatus: [{ size: 0, sizeLeft: 0 }] }, false).percent, null);
    // Bad numbers from upstream never push the figure outside 0 to 100.
    assert.equal(model.downloadProgress({ downloadStatus: [{ size: 100, sizeLeft: 500 }] }, false).percent, 0);
    assert.equal(model.downloadProgress({ downloadStatus: [{ size: 100, sizeLeft: -5 }] }, false).percent, 100);
});

test('time left reads naturally', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    const at = minutes => new Date(now + minutes * 60000);
    assert.equal(model.formatTimeLeft(null, now), '');
    assert.equal(model.formatTimeLeft(at(-5), now), 'almost done');
    assert.equal(model.formatTimeLeft(at(1), now), 'almost done');
    assert.equal(model.formatTimeLeft(at(10), now), 'about 10 minutes left');
    assert.equal(model.formatTimeLeft(at(150), now), 'about 3 hours left');
    assert.equal(model.formatTimeLeft(at(60 * 72), now), 'about 3 days left');
});

test('request holders: own requests, others, and names only for those allowed to see them', () => {
    const mediaInfo = {
        requests: [
            request({ id: 1, requestedBy: { id: 1, displayName: 'alice' } }),
            request({ id: 2, requestedBy: { id: 2, displayName: 'bob' } }),
            request({ id: 3, requestedBy: { id: 2, displayName: 'bob' }, is4k: true }),
            request({ id: 4, requestedBy: { id: 3, displayName: 'carol' }, status: R.DECLINED })
        ]
    };

    const alice = plain(model.requestHolders(mediaInfo, user(1, P.REQUEST), false));
    assert.deepEqual(alice.own.map(r => r.id), [1]);
    assert.deepEqual(alice.others.map(r => r.id), [2]);
    assert.deepEqual(alice.names, []);

    const admin = plain(model.requestHolders(mediaInfo, user(9, P.ADMIN), false));
    assert.deepEqual(admin.names, ['alice', 'bob']);
    assert.deepEqual(plain(model.requestHolders(mediaInfo, user(9, P.REQUEST_VIEW), true)).names, ['bob']);
    assert.deepEqual(plain(model.requestHolders(null, user(1, P.REQUEST), false)), { own: [], others: [], names: [] });
});

test('request status labels', () => {
    assert.equal(model.requestStatusLabel(request({ status: R.PENDING })).label, 'Pending approval');
    assert.equal(model.requestStatusLabel(request({ status: R.DECLINED })).kind, 'declined');
    assert.equal(model.requestStatusLabel(request({ status: R.FAILED })).kind, 'failed');
    assert.equal(model.requestStatusLabel(request({ status: R.COMPLETED })).kind, 'available');
    assert.equal(model.requestStatusLabel(request({ status: R.APPROVED, media: { status: M.PROCESSING } })).label, 'Approved');
    assert.equal(model.requestStatusLabel(request({ status: R.APPROVED, media: { status: M.AVAILABLE } })).kind, 'available');
    assert.equal(model.requestStatusLabel(request({ status: R.APPROVED, is4k: true, media: { status: M.AVAILABLE, status4k: M.PARTIALLY_AVAILABLE } })).kind, 'partial');
});

test('routes: only #/requests belongs to the page, and every value is checked', () => {
    assert.equal(model.parseRoute('#/home'), null);
    assert.equal(model.parseRoute('#/requestsx'), null);
    assert.equal(model.parseRoute(''), null);
    assert.equal(model.parseRoute(undefined), null);
    assert.deepEqual(plain(model.parseRoute('#/requests')), { view: 'discover' });
    assert.deepEqual(plain(model.parseRoute('#/Requests/')), { view: 'discover' });
    assert.deepEqual(plain(model.parseRoute('#/requests?view=movie&id=27205')), { view: 'movie', id: 27205 });
    assert.deepEqual(plain(model.parseRoute('#/requests?view=tv&id=-3')), { view: 'discover' });
    assert.deepEqual(plain(model.parseRoute('#/requests?view=tv&id=1.5')), { view: 'discover' });
    assert.deepEqual(plain(model.parseRoute('#/requests?view=search&q=%20%20')), { view: 'discover' });
    assert.deepEqual(plain(model.parseRoute('#/requests?view=search&q=star+wars')), { view: 'search', query: 'star wars' });
    assert.deepEqual(plain(model.parseRoute('#/requests?view=requests&filter=bogus')), { view: 'requests', filter: 'all' });
    assert.deepEqual(plain(model.parseRoute('#/requests?view=requests&filter=pending')), { view: 'requests', filter: 'pending' });
    assert.equal(model.parseRoute('#/requests?view=search&q=' + 'x'.repeat(500)).query.length, 200);
});

test('routeHash round-trips through parseRoute', () => {
    for (const route of [
        { view: 'discover' },
        { view: 'movie', id: 5 },
        { view: 'tv', id: 1396 },
        { view: 'search', query: 'a & b ? #c' },
        { view: 'requests', filter: 'failed' }
    ]) {
        const parsed = plain(model.parseRoute(model.routeHash(route)));
        assert.deepEqual(parsed, route.view === 'requests' ? { view: 'requests', filter: route.filter } : route);
    }

    assert.equal(model.routeHash({ view: 'requests', filter: 'all' }), '#/requests?view=requests');
});

test('imageUrl only accepts plain TMDB paths', () => {
    assert.equal(model.imageUrl('/abc123.jpg', 'w342'), 'https://image.tmdb.org/t/p/w342/abc123.jpg');
    for (const bad of [null, '', 'abc.jpg', '/../etc/passwd', '/a b.jpg', '/a".jpg', "/a').jpg", 'javascript:alert(1)', '//evil.example/x.jpg', '/x.jpg?y=1']) {
        assert.equal(model.imageUrl(bad, 'w342'), '', String(bad));
    }
});

test('escapeHtml escapes markup and quotes', () => {
    assert.equal(model.escapeHtml('<img src=x onerror="a">\'&'), '&lt;img src=x onerror=&quot;a&quot;&gt;&#39;&amp;');
    assert.equal(model.escapeHtml(null), '');
    assert.equal(model.escapeHtml(5), '5');
});

test('titles and years come from either Seerr shape', () => {
    assert.equal(model.titleOf({ title: 'Inception' }), 'Inception');
    assert.equal(model.titleOf({ name: 'Breaking Bad' }), 'Breaking Bad');
    assert.equal(model.titleOf({}), 'Untitled');
    assert.equal(model.yearOf({ releaseDate: '2010-07-15' }), '2010');
    assert.equal(model.yearOf({ firstAirDate: '2008-01-20' }), '2008');
    assert.equal(model.yearOf({ releaseDate: '' }), '');
});

// --- The proxy client -------------------------------------------------------------------

function fakeResponse(status, body, headers = {}) {
    const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: name => headers[name] ?? null },
        text: async () => text
    };
}

function fakeClient(overrides = {}) {
    return Object.assign({
        getUrl: (name, params) => {
            const query = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
            return 'http://jf/' + name + (query ? '?' + query : '');
        },
        setRequestHeaders: headers => { headers.Authorization = 'MediaBrowser Client="Jellyfin Web", Token="user-token"'; },
        accessToken: () => 'user-token'
    }, overrides);
}

function apiWith(responder, client = fakeClient()) {
    const calls = [];
    const api = model.createApi(async (url, init) => {
        calls.push({ url, init });
        return responder(url, init);
    }, () => client);
    return { api, calls };
}

test('the proxy client sends the user\'s own Jellyfin authorization to Seerr Proxy only', async () => {
    const { api, calls } = apiWith(() => fakeResponse(200, { id: 3 }));

    const me = await api.get('auth/me');
    await api.post('request', { mediaType: 'movie', mediaId: 1, is4k: false });
    await api.put('request/9', { mediaType: 'tv', seasons: [1] });
    await api.remove('request/9');

    assert.equal(me.id, 3);
    assert.deepEqual(calls.map(call => [call.init.method, call.url]), [
        ['GET', 'http://jf/Plugins/SeerrProxy/api/v1/auth/me'],
        ['POST', 'http://jf/Plugins/SeerrProxy/api/v1/request'],
        ['PUT', 'http://jf/Plugins/SeerrProxy/api/v1/request/9'],
        ['DELETE', 'http://jf/Plugins/SeerrProxy/api/v1/request/9']
    ]);
    for (const call of calls) {
        assert.equal(call.init.headers.Authorization, 'MediaBrowser Client="Jellyfin Web", Token="user-token"');
        assert.deepEqual(Object.keys(call.init.headers).filter(name => /x-api|user/i.test(name)), []);
        assert.equal(call.init.cache, 'no-store');
    }

    assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
    assert.equal(calls[1].init.body, '{"mediaType":"movie","mediaId":1,"is4k":false}');
    assert.equal(calls[0].init.body, undefined);
});

test('the proxy client falls back to a token-only header', async () => {
    const { api, calls } = apiWith(() => fakeResponse(200, {}), fakeClient({ setRequestHeaders: undefined }));
    await api.get('settings/public');
    assert.equal(calls[0].init.headers.Authorization, 'MediaBrowser Token="user-token"');
});

test('the proxy client passes query values through ApiClient.getUrl', async () => {
    const { api, calls } = apiWith(() => fakeResponse(200, { results: [] }));
    await api.get('search', { query: 'star wars & co', page: 2 });
    assert.equal(calls[0].url, 'http://jf/Plugins/SeerrProxy/api/v1/search?query=star+wars+%26+co&page=2');
});

test('the proxy client refuses to run without a signed-in Jellyfin client', async () => {
    const api = model.createApi(async () => fakeResponse(200, {}), () => undefined);
    await assert.rejects(api.get('auth/me'), error => error.status === 401 && error.code === 'MissingJellyfinUser');
});

test('the proxy client reports errors in either casing, with Retry-After', async () => {
    const pascal = apiWith(() => fakeResponse(404, { StatusCode: 404, Error: 'SeerrUserNotLinked', Message: 'not linked' })).api;
    await assert.rejects(pascal.get('auth/me'), error => error.status === 404 && error.code === 'SeerrUserNotLinked' && error.message === 'not linked');

    const camel = apiWith(() => fakeResponse(403, { error: 'SeerrError', message: 'Movie Quota exceeded.' })).api;
    await assert.rejects(camel.post('request', {}), error => error.code === 'SeerrError' && error.message === 'Movie Quota exceeded.');

    const limited = apiWith(() => fakeResponse(429, { Error: 'RateLimited' }, { 'Retry-After': '17' })).api;
    await assert.rejects(limited.get('search'), error => error.status === 429 && error.retryAfter === 17);

    const html = apiWith(() => fakeResponse(404, '<html>not found</html>')).api;
    await assert.rejects(html.get('auth/me'), error => error.status === 404 && error.code === '');

    const offline = model.createApi(async () => { throw new TypeError('Failed to fetch'); }, () => fakeClient());
    await assert.rejects(offline.get('auth/me'), error => error.status === 0);
});

test('the proxy client treats 202 as accepted and 204 as empty', async () => {
    const accepted = apiWith(() => fakeResponse(202, { message: 'No seasons available to request' })).api;
    const result = await accepted.post('request', {});
    assert.equal(result.accepted, true);
    assert.equal(result.data.message, 'No seasons available to request');

    const empty = apiWith(() => fakeResponse(204)).api;
    assert.equal(await empty.remove('request/1'), null);
});

test('describeError explains every way the page can be blocked', () => {
    const E = model.ApiError;
    const kind = error => model.describeError(error).kind;
    assert.equal(kind(new E(401, 'MissingJellyfinUser')), 'session');
    assert.equal(kind(new E(403, 'PluginDisabled')), 'disabled');
    assert.equal(kind(new E(404, 'SeerrUserNotLinked')), 'unlinked');
    assert.equal(kind(new E(404, 'PluginInactive')), 'proxy');
    assert.equal(kind(new E(404, '')), 'proxy');
    assert.equal(kind(new E(502, 'SeerrUnreachable')), 'unreachable');
    assert.equal(kind(new E(503, 'PluginNotConfigured')), 'unconfigured');

    for (const error of [new E(401, 'MissingJellyfinUser'), new E(404, 'SeerrUserNotLinked'), new E(503, 'PluginNotConfigured')]) {
        assert.equal(model.describeError(error).blocking, true);
    }

    // Refusals from Seerr itself are passed on, not blocking.
    const quota = model.describeError(new E(403, 'SeerrError', 'Movie Quota exceeded.'));
    assert.equal(quota.blocking, false);
    assert.equal(quota.text, 'Movie Quota exceeded.');
    assert.equal(model.describeError(new E(401, 'SeerrError', 'You do not have permission to delete this request.')).blocking, false);
    assert.match(model.describeError(new E(429, 'RateLimited', '', 30)).text, /30 seconds/);
    assert.equal(model.describeError(new Error('boom')).blocking, false);
});
