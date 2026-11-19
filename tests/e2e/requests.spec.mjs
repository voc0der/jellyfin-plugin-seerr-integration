import { expect, test } from '@playwright/test';
import { openRequests, seerrRequests, seerrRequestsFor, signIn, stack } from './harness/session.mjs';

// Well-known TMDB titles with stable ids.
const MOVIE = { id: 27205, title: 'Inception' };
const SERIES = { id: 1396, title: 'Breaking Bad' };

test.describe.configure({ mode: 'serial' });

// Any uncaught error from the page's own script fails the test. Jellyfin Web has errors of
// its own (its home page throws when left within a second of signing in), so only errors
// whose stack runs through this plugin's file count.
let clientErrors = [];
test.beforeEach(async ({ page }) => {
    clientErrors = [];
    page.on('pageerror', error => {
        if (/seerr-integration\.js/.test(error.stack || '')) {
            clientErrors.push(error.stack);
        }
    });
});
test.afterEach(() => {
    expect(clientErrors, clientErrors.join('\n')).toEqual([]);
});

// Every call the page makes, so a test can prove where they went and what they carried.
function recordCalls(page) {
    const calls = [];
    page.on('request', request => {
        calls.push({
            url: request.url(),
            method: request.method(),
            headers: request.headers(),
            body: request.postData() ?? ''
        });
    });
    return calls;
}

function expectIdentityBlind(calls) {
    const { seerrBase } = stack();
    for (const call of calls) {
        expect(call.url.startsWith(seerrBase), `the browser called Seerr directly: ${call.url}`).toBeFalsy();
        if (!call.url.includes('/Plugins/SeerrProxy/')) {
            continue;
        }

        expect(Object.keys(call.headers).map(name => name.toLowerCase())).not.toContain('x-api-user');
        expect(call.url).not.toMatch(/[?&](requestedBy|userId)=/i);
        expect(call.body).not.toMatch(/"(userId|user|requestedBy|modifiedBy)"\s*:/);
    }
}

test('Requests sits right after Home in the legacy drawer', async ({ page }) => {
    await signIn(page, stack().users.alice, 'desktop-legacy');
    await page.locator('.mainDrawerButton').click();
    const entry = page.locator('.mainDrawer-scrollContainer [data-seerr-integration-nav="drawer"]');
    await expect(entry).toBeVisible();
    await expect(entry).toHaveText(/Requests/);
    const before = await entry.evaluate(node => {
        let previous = node.previousElementSibling;
        while (previous && previous.classList.contains('customMenuOptions')) {
            previous = previous.previousElementSibling;
        }

        return previous && previous.getAttribute('href');
    });
    expect(before).toBe('#/home');

    await entry.click();
    await expect(page).toHaveURL(/#\/requests$/);
    await expect(page.locator('#seerrIntegrationPage')).toBeVisible();
    await expect(page.locator('#fallbackPage')).toBeHidden();
    await expect(page.locator('[data-row="trending"] .card').first()).toBeVisible();
    await expect(entry).toHaveClass(/navMenuOption-selected/);
});

test('Requests sits after Favorites in the Modern app bar', async ({ page }) => {
    await signIn(page, stack().users.alice);
    const entry = page.locator('.MuiAppBar-root [data-seerr-integration-nav="appbar"]');
    await expect(entry).toBeVisible();
    await expect(entry).toHaveText('Requests');
    const before = await entry.evaluate(node => node.previousElementSibling && node.previousElementSibling.getAttribute('href'));
    expect(before).toBe('#/home?tab=1');

    await entry.click();
    await expect(page).toHaveURL(/#\/requests$/);
    await expect(page.locator('#seerrIntegrationPage')).toBeVisible();
    await expect(page.locator('#fallbackPage')).toBeHidden();
});

test('Requests sits after Favorites in the Modern phone menu', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
        await signIn(page, stack().users.alice);
        await page.locator('button[aria-label="Open Menu"]').click();
        const entry = page.locator('.MuiDrawer-root [data-seerr-integration-nav="menu"]');
        await expect(entry).toBeVisible();
        await expect(entry).toHaveText(/Requests/);

        await entry.click();
        await expect(page).toHaveURL(/#\/requests$/);
        await expect(page.locator('#seerrIntegrationPage')).toBeVisible();
        await expect(page.locator('.MuiDrawer-root .MuiBackdrop-root')).toHaveCount(0);
        await expect(page.locator('[data-row="trending"] .card').first()).toBeVisible();
    } finally {
        await context.close();
    }
});

test('discover shows rows of titles from Seerr', async ({ page }) => {
    await signIn(page, stack().users.alice);
    await openRequests(page);
    for (const row of ['trending', 'movies', 'tv']) {
        await expect(page.locator(`[data-row="${row}"] .card`).first()).toBeVisible();
    }

    await expect(page.locator('.sui-tab-active')).toHaveText('Discover');
    await expect(page.locator('.sui-tabs')).toContainText('My requests');
});

test('search finds a movie by title', async ({ page }) => {
    await signIn(page, stack().users.alice);
    await openRequests(page);
    await page.locator('.sui-search input').fill(MOVIE.title);
    await expect(page).toHaveURL(/view=search&q=Inception/);
    const card = page.locator(`.sui-grid .card[data-media-type="movie"][data-id="${MOVIE.id}"]`);
    await expect(card).toBeVisible();
    await card.locator('.cardImageContainer').click();
    await expect(page).toHaveURL(new RegExp(`view=movie&id=${MOVIE.id}`));
    await expect(page.locator('.sui-details-title')).toHaveText(MOVIE.title);
});

test('alice requests a movie, and Seerr records it as alice', async ({ page }) => {
    const { users } = stack();
    const calls = recordCalls(page);
    await signIn(page, users.alice);
    await openRequests(page, `?view=movie&id=${MOVIE.id}`);
    await page.locator('[data-action="request-movie"][data-4k="false"]').click();
    await expect(page.locator('.sui-toast')).toContainText('Requested Inception');
    await expect(page.locator('.sui-details .sui-chip')).toContainText('Pending approval');
    await expect(page.locator('[data-action="cancel-request"]')).toBeVisible();

    const requests = await seerrRequestsFor(MOVIE.id);
    expect(requests).toHaveLength(1);
    expect(requests[0].requestedBy.id).toBe(users.alice.seerrId);
    expect(requests[0].status).toBe(1);
    expectIdentityBlind(calls);
});

test('bob requests one season of a series, and Seerr records it as bob', async ({ page }) => {
    const { users } = stack();
    const calls = recordCalls(page);
    await signIn(page, users.bob);
    await openRequests(page, `?view=tv&id=${SERIES.id}`);
    await page.locator('[data-action="request-tv"][data-4k="false"]').click();

    const dialog = page.locator('.sui-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.sui-dialog-list input')).toHaveCount(5);
    await dialog.locator('.sui-dialog-list input[value="1"]').check();
    await expect(dialog.locator('[data-dialog-action="confirm"]')).toHaveText('Request 1 season');
    await dialog.locator('[data-dialog-action="confirm"]').click();
    await expect(page.locator('.sui-toast')).toContainText('Requested Breaking Bad');

    const requests = await seerrRequestsFor(SERIES.id);
    expect(requests).toHaveLength(1);
    expect(requests[0].requestedBy.id).toBe(users.bob.seerrId);
    expect(requests[0].seasons.map(season => season.seasonNumber)).toEqual([1]);
    expectIdentityBlind(calls);
});

test('each user sees only their own requests', async ({ page, browser }) => {
    const { users } = stack();
    await signIn(page, users.alice);
    await openRequests(page, '?view=requests');
    await expect(page.locator('.sui-request-row')).toHaveCount(1);
    await expect(page.locator(`.sui-request-row[data-tmdb-id="${MOVIE.id}"] .sui-request-name`)).toHaveText(/Inception/);

    const context = await browser.newContext();
    const bobPage = await context.newPage();
    try {
        await signIn(bobPage, users.bob);
        await openRequests(bobPage, '?view=requests');
        await expect(bobPage.locator('.sui-request-row')).toHaveCount(1);
        await expect(bobPage.locator(`.sui-request-row[data-tmdb-id="${SERIES.id}"]`)).toBeVisible();
        await expect(bobPage.locator(`.sui-request-row[data-tmdb-id="${MOVIE.id}"]`)).toHaveCount(0);
    } finally {
        await context.close();
    }
});

test('bob adds a season to his pending request', async ({ page }) => {
    const { users } = stack();
    await signIn(page, users.bob);
    await openRequests(page, `?view=tv&id=${SERIES.id}`);
    await page.locator('.sui-details [data-action="edit-request"]').click();
    const dialog = page.locator('.sui-dialog');
    await expect(dialog.locator('.sui-dialog-list input[value="1"]')).toBeChecked();
    await dialog.locator('.sui-dialog-list input[value="2"]').check();
    await dialog.locator('[data-dialog-action="confirm"]').click();
    await expect(page.locator('.sui-toast')).toContainText('Request updated');

    const requests = await seerrRequestsFor(SERIES.id);
    expect(requests).toHaveLength(1);
    expect(requests[0].requestedBy.id).toBe(users.bob.seerrId);
    expect(requests[0].seasons.map(season => season.seasonNumber).sort()).toEqual([1, 2]);
});

test('alice sees that someone else already requested the series', async ({ page }) => {
    await signIn(page, stack().users.alice);
    await openRequests(page, `?view=tv&id=${SERIES.id}`);
    await expect(page.locator('.sui-details .sui-note')).toHaveText(['Already requested by someone else.']);
    await expect(page.locator('.sui-details [data-action="edit-request"]')).toHaveCount(0);
    await expect(page.locator('.sui-details [data-action="cancel-request"]')).toHaveCount(0);
    // Seasons bob holds are pending; the rest can still be requested by alice.
    await expect(page.locator('.sui-details [data-action="request-tv"]')).toHaveText(/Request more/);
});

test('the admin sees everyone\'s requests with who asked', async ({ page }) => {
    await signIn(page, { name: 'admin', password: 'harness-admin-pw' });
    await openRequests(page, '?view=requests');
    await expect(page.locator('.sui-tab-active').first()).toHaveText('Requests');
    await expect(page.locator(`.sui-request-row[data-tmdb-id="${SERIES.id}"] .sui-request-meta`)).toContainText('by bob');
    await expect(page.locator(`.sui-request-row[data-tmdb-id="${MOVIE.id}"] .sui-request-meta`)).toContainText('by alice');
    await openRequests(page, `?view=tv&id=${SERIES.id}`);
    await expect(page.locator('.sui-details .sui-note')).toHaveText(['Requested by bob.']);
});

test('alice cancels her pending request', async ({ page }) => {
    const { users } = stack();
    await signIn(page, users.alice);
    await openRequests(page, '?view=requests');
    await page.locator(`.sui-request-row[data-tmdb-id="${MOVIE.id}"] [data-action="cancel-request"]`).click();
    await page.locator('.sui-dialog [data-dialog-action="confirm"]').click();
    await expect(page.locator('.sui-toast')).toContainText('Request cancelled');
    await expect(page.locator(`.sui-request-row[data-tmdb-id="${MOVIE.id}"]`)).toHaveCount(0);
    expect(await seerrRequestsFor(MOVIE.id)).toHaveLength(0);
    expect(await seerrRequestsFor(SERIES.id)).toHaveLength(1);
});

test('an unlinked user is told so, and nothing is requested for them', async ({ page }) => {
    const before = (await seerrRequests()).length;
    await signIn(page, stack().users.carol);
    await openRequests(page, `?view=movie&id=${MOVIE.id}`);
    await expect(page.locator('.sui-message h2')).toHaveText('Your account is not linked');
    await expect(page.locator('[data-action^="request"]')).toHaveCount(0);
    expect((await seerrRequests()).length).toBe(before);
});

test('leaving the page gives Jellyfin its page back', async ({ page }) => {
    await signIn(page, stack().users.alice, 'desktop-legacy');
    await expect(page.locator('.skinHeader .headerTabs .emby-tab-button').first()).toBeVisible();
    await openRequests(page);
    // Jellyfin's header shows this page's title and drops the previous page's tabs.
    await expect(page.locator('.skinHeader .pageTitle')).toHaveText('Requests');
    await expect(page.locator('.skinHeader .headerTabs .emby-tab-button')).toHaveCount(0);
    await page.locator('.mainDrawerButton').click();
    await page.locator('.mainDrawer-scrollContainer a.navMenuOption[href="#/home"]').click();
    await expect(page).toHaveURL(/#\/home/);
    await expect(page.locator('#seerrIntegrationPage')).toBeHidden();
    await expect(page.locator('html')).not.toHaveClass(/seerr-integration-active/);
    // Jellyfin Web keeps a hidden cached copy of a page it has shown before.
    await expect(page.locator('#indexPage:not(.hide)')).toBeVisible();
    await expect(page.locator('.skinHeader .headerTabs .emby-tab-button').first()).toBeVisible();
});

test('bob is told why an approved request has no Cancel', async ({ page }) => {
    const { users, seerrBase, seerrApiKey } = stack();
    const [pending] = await seerrRequestsFor(SERIES.id);
    const approve = await fetch(`${seerrBase}/api/v1/request/${pending.id}/approve`, {
        method: 'POST',
        headers: { 'X-Api-Key': seerrApiKey }
    });
    expect(approve.ok).toBeTruthy();
    const [approved] = await seerrRequestsFor(SERIES.id);
    expect(approved.status).toBe(2);

    await signIn(page, users.bob);
    await openRequests(page, '?view=requests');
    const row = page.locator(`.sui-request-row[data-tmdb-id="${SERIES.id}"]`);
    await expect(row.locator('.sui-chip').first()).toHaveText('Approved');
    await expect(row.locator('[data-action="cancel-request"]')).toHaveCount(0);
    await expect(row).toContainText('Approved, so only a server admin can withdraw it.');

    await openRequests(page, `?view=tv&id=${SERIES.id}`);
    await expect(page.locator('.sui-details .sui-note')).toHaveText(['You requested this. It is approved, so only a server admin can withdraw it now.']);
});

test('a download in progress shows how far it has got', async ({ page }) => {
    // No Radarr here, so the proxy's real answer gets the queue entry Seerr would add.
    await page.route(`**/Plugins/SeerrProxy/api/v1/movie/${MOVIE.id}`, async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.mediaInfo = Object.assign({}, body.mediaInfo, {
            status: 3,
            downloadStatus: [{
                mediaType: 'movie',
                externalId: 1,
                size: 4000,
                sizeLeft: 1000,
                status: 'downloading',
                timeLeft: '00:10:00',
                estimatedCompletionTime: new Date(Date.now() + 10 * 60_000).toISOString(),
                title: MOVIE.title,
                downloadId: 'harness'
            }]
        });
        await route.fulfill({ response, json: body });
    });

    await signIn(page, stack().users.alice);
    await openRequests(page, `?view=movie&id=${MOVIE.id}`);
    const progress = page.locator('.sui-details .sui-progress');
    await expect(progress).toContainText('Downloading · 75% · about 10 minutes left');
    await expect(progress.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '75');
    await expect(page.locator('.sui-details .sui-chip')).toContainText('Requested');
});
