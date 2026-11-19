import { expect } from '@playwright/test';

export function stack() {
    return JSON.parse(process.env.SEERR_INTEGRATION_E2E);
}

// Signs a user in through Jellyfin Web's own login form. `layout` is a Display mode value:
// undefined for Auto (Modern), or 'desktop-legacy', 'mobile-legacy', 'tv'.
export async function signIn(page, user, layout) {
    const { base } = stack();
    await page.addInitScript(value => {
        if (value) {
            localStorage.setItem('layout', value);
        } else {
            localStorage.removeItem('layout');
        }
    }, layout ?? '');
    await page.goto(`${base}/web/`);
    await page.locator('#txtManualName').fill(user.name);
    await page.locator('#txtManualPassword').fill(user.password);
    await page.locator('#txtManualPassword').press('Enter');
    await page.waitForURL(/#\/home/, { timeout: 30_000 });
}

export async function openRequests(page, query = '') {
    await page.evaluate(hash => { window.location.hash = hash; }, '#/requests' + query);
    await expect(page.locator('#seerrIntegrationPage')).toBeVisible();
}

// Seerr's own view of the requests, through its API key: the ground truth for who asked.
export async function seerrRequests() {
    const { seerrBase, seerrApiKey } = stack();
    const response = await fetch(`${seerrBase}/api/v1/request?take=100&skip=0&filter=all&sort=added`, {
        headers: { 'X-Api-Key': seerrApiKey }
    });
    expect(response.ok).toBeTruthy();
    return (await response.json()).results;
}

export async function seerrRequestsFor(tmdbId) {
    return (await seerrRequests()).filter(request => request.media && request.media.tmdbId === tmdbId);
}
