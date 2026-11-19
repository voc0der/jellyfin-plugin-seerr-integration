// Boots a throwaway Jellyfin with this repository's build of the plugin, Seerr Proxy and
// JavaScript Injector installed, next to a real Seerr, and links them the way an admin would.
//
// Real services rather than stubs: what this harness exists to catch lives in the seams. The
// injector decides whether the page loads at all, Jellyfin Web decides where navigation lives,
// the proxy decides which Seerr account acts, and only Seerr can say who a request belongs to.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sleep = ms => new Promise(done => setTimeout(done, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(HARNESS_ROOT, '../..');

// The newest Jellyfin release: the page has to work on what people run.
export const JELLYFIN_IMAGE = process.env.JELLYFIN_IMAGE ?? 'jellyfin/jellyfin:12.4';
export const SEERR_IMAGE = process.env.SEERR_IMAGE ?? 'ghcr.io/seerr-team/seerr:develop';

// The releases people install, pinned by checksum: their DLLs are loaded into Jellyfin, so a
// replaced release asset must fail the run rather than be installed. PROXY_DIR builds Seerr
// Proxy from a checkout instead.
const INJECTOR_ZIP = {
    url: process.env.INJECTOR_ZIP_URL
        ?? 'https://github.com/n00bcodr/Jellyfin-JavaScript-Injector/releases/download/4.1.0.0/Jellyfin.Plugin.JavaScriptInjector_12.0.0.zip',
    sha256: process.env.INJECTOR_ZIP_SHA256 ?? '099aa99dd9aa7df330ea6aeb9e9e74adb5373f01927bc9f0988493b3cefd18d6'
};
const PROXY_ZIP = {
    url: process.env.PROXY_ZIP_URL
        ?? 'https://github.com/voc0der/jellyfin-plugin-seerr-proxy/releases/download/1.0.0.15/Seerr_Proxy_1.0.0.15.zip',
    sha256: process.env.PROXY_ZIP_SHA256 ?? '9fadef5c0d5c21ecfaa2b4979e49df9d552edb0ba496e4048521aa8bdfdb1ca6'
};

export const PLUGIN_ID = 'c937e280-0ac7-4250-a620-8c5892e628fe';
export const PROXY_ID = '1ac3cf0f-f0f9-443a-be08-be38e48ff683';
export const ADMIN = { name: 'admin', password: 'harness-admin-pw' };

// alice and bob are imported into Seerr; carol is not, so she is the unlinked user.
export const USERS = ['alice', 'bob', 'carol'];
export const LINKED_USERS = ['alice', 'bob'];

const NETWORK = 'seerr-integration-e2e';
const JELLYFIN = 'seerr-integration-e2e-jellyfin';
const SEERR = 'seerr-integration-e2e-seerr';
const CLIENT_AUTH = 'MediaBrowser Client="Seerr Integration harness", Device="harness", '
    + 'DeviceId="seerr-integration-e2e", Version="1.0.0"';

async function docker(...args) {
    const { stdout } = await exec('docker', args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
}

const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');

// A cached copy is used only if it still matches the checksum. A download lands beside the
// cache and replaces it only once its checksum has been checked.
async function download({ url, sha256 }) {
    const target = join(HARNESS_ROOT, '.cache', basename(new URL(url).pathname));
    const cached = await readFile(target).catch(() => null);
    if (cached && sha256Of(cached) === sha256) {
        return target;
    }

    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}.partial`;
    await exec('curl', ['--fail', '--silent', '--show-error', '--location', '--output', partial, url]);
    const actual = sha256Of(await readFile(partial));
    if (actual !== sha256) {
        await rm(partial, { force: true });
        throw new Error(`${url} has SHA-256 ${actual}, not the pinned ${sha256}. `
            + 'For another release, set the matching *_ZIP_SHA256 variable.');
    }

    await rename(partial, target);
    return target;
}

// The plugin folders Jellyfin loads, staged inside the harness folder: rootless Docker cannot
// see this process's /tmp, so a staging folder there would arrive empty.
export async function stagePlugins() {
    const build = join(HARNESS_ROOT, '.build');
    const plugins = join(build, 'plugins');
    await rm(plugins, { recursive: true, force: true });

    const own = join(plugins, 'Seerr Integration_1.0.0.0');
    await exec('dotnet', [
        'build', join(REPO_ROOT, 'Jellyfin.Plugin.SeerrIntegration.csproj'),
        '--configuration', 'Release', '--nologo', '--verbosity', 'quiet', '--output', join(build, 'plugin')
    ], { maxBuffer: 64 * 1024 * 1024 });
    await mkdir(own, { recursive: true });
    await exec('cp', [join(build, 'plugin', 'Jellyfin.Plugin.SeerrIntegration.dll'), own]);

    const proxy = join(plugins, 'Seerr Proxy_1.0.0.0');
    await mkdir(proxy, { recursive: true });
    if (process.env.PROXY_DIR) {
        await exec('dotnet', [
            'build', join(resolve(process.env.PROXY_DIR), 'Jellyfin.Plugin.SeerrProxy.csproj'),
            '--configuration', 'Release', '--nologo', '--verbosity', 'quiet', '--output', join(build, 'proxy')
        ], { maxBuffer: 64 * 1024 * 1024 });
        await exec('cp', [join(build, 'proxy', 'Jellyfin.Plugin.SeerrProxy.dll'), proxy]);
    } else {
        const zip = await download(PROXY_ZIP);
        await exec('unzip', ['-q', '-o', '-j', zip, '*.dll', '-d', proxy]);
    }

    const injector = join(plugins, 'JavaScript Injector_4.1.0.0');
    await mkdir(injector, { recursive: true });
    const injectorZip = await download(INJECTOR_ZIP);
    await exec('unzip', ['-q', '-o', '-j', injectorZip, '*.dll', '-d', injector]);

    return plugins;
}

async function waitFor(url, accept, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    let last = 'never responded';
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            const type = response.headers.get('content-type') ?? '';
            if (response.ok && type.includes('json')) {
                const body = await response.json();
                if (accept(body)) {
                    return body;
                }

                last = 'not ready yet';
            } else {
                last = `${response.status} ${type}`;
            }
        } catch (error) {
            last = error.message;
        }

        await sleep(1000);
    }

    throw new Error(`${what} did not come up within ${timeoutMs}ms (last: ${last})`);
}

// Jellyfin rewrites its configuration between wizard steps and briefly answers 404 or 503.
async function retry(fn, attempts = 30) {
    let last;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (error) {
            last = error;
            await sleep(1000);
        }
    }

    throw last;
}

async function jellyfin(base, method, path, { token, body } = {}) {
    const response = await fetch(base + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: token ? `${CLIENT_AUTH}, Token="${token}"` : CLIENT_AUTH
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
    }

    return text ? JSON.parse(text) : null;
}

class SeerrSession {
    constructor(base) {
        this.base = base;
        this.cookie = '';
    }

    async call(method, path, body) {
        const response = await fetch(this.base + path, {
            method,
            headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const cookies = response.headers.getSetCookie?.() ?? [];
        if (cookies.length) {
            this.cookie = cookies.map(cookie => cookie.split(';')[0]).join('; ');
        }

        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Seerr ${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
        }

        return text ? JSON.parse(text) : null;
    }
}

export async function stopStack({ logDir } = {}) {
    if (logDir) {
        await mkdir(logDir, { recursive: true });
        for (const name of [JELLYFIN, SEERR]) {
            const logs = await exec('docker', ['logs', name], { maxBuffer: 64 * 1024 * 1024 })
                .then(({ stdout, stderr }) => stdout + stderr)
                .catch(() => '');
            if (logs) {
                await writeFile(join(logDir, `${name}.log`), logs);
            }
        }
    }

    await docker('rm', '-f', '-v', JELLYFIN, SEERR).catch(() => {});
    await docker('network', 'rm', NETWORK).catch(() => {});
}

export async function startStack() {
    const plugins = await stagePlugins();
    await stopStack();

    await docker('network', 'create', NETWORK);
    await docker('run', '--detach', '--name', SEERR, '--network', NETWORK, '--network-alias', 'seerr',
        '--publish', '127.0.0.1::5055', '-e', 'TZ=UTC', SEERR_IMAGE);
    await docker('create', '--name', JELLYFIN, '--network', NETWORK, '--network-alias', 'jellyfin',
        '--publish', '127.0.0.1::8096', JELLYFIN_IMAGE);
    await docker('cp', plugins, `${JELLYFIN}:/config/`);
    await docker('start', JELLYFIN);

    const port = async (name, inner) => (await docker('port', name, inner)).split('\n')[0].split(':').pop();
    const base = `http://127.0.0.1:${await port(JELLYFIN, '8096/tcp')}`;
    const seerrBase = `http://127.0.0.1:${await port(SEERR, '5055/tcp')}`;

    // A booting Jellyfin first answers with a placeholder, then 503, then the real thing.
    let info = await waitFor(`${base}/System/Info/Public`, body => 'Version' in body, 180_000, 'Jellyfin');
    if (!info.StartupWizardCompleted) {
        await waitFor(`${base}/Startup/Configuration`, () => true, 120_000, 'the Jellyfin wizard');
        await retry(() => jellyfin(base, 'POST', '/Startup/Configuration', {
            body: { UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' }
        }));
        await retry(() => jellyfin(base, 'GET', '/Startup/User'));
        await retry(() => jellyfin(base, 'POST', '/Startup/User', { body: { Name: ADMIN.name, Password: ADMIN.password } }));
        await retry(() => jellyfin(base, 'POST', '/Startup/RemoteAccess', {
            body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false }
        }));
        await retry(() => jellyfin(base, 'POST', '/Startup/Complete'));
    }

    info = await waitFor(`${base}/System/Info/Public`, body => 'Version' in body, 60_000, 'Jellyfin');
    const adminSession = await retry(() => jellyfin(base, 'POST', '/Users/AuthenticateByName', {
        body: { Username: ADMIN.name, Pw: ADMIN.password }
    }));
    const adminToken = adminSession.AccessToken;

    const loaded = await jellyfin(base, 'GET', '/Plugins', { token: adminToken });
    for (const name of ['Seerr Integration', 'Seerr Proxy', 'JavaScript Injector']) {
        const plugin = loaded.find(entry => entry.Name === name);
        if (!plugin || plugin.Status !== 'Active') {
            const tail = (await exec('docker', ['logs', '--tail', '80', JELLYFIN]).catch(() => ({ stdout: '' }))).stdout;
            throw new Error(`${name} did not load on Jellyfin ${info.Version} (status: ${plugin?.Status ?? 'not listed'}).\n${tail}`);
        }
    }

    const users = {};
    for (const name of USERS) {
        const created = await jellyfin(base, 'POST', '/Users/New', {
            token: adminToken,
            body: { Name: name, Password: `${name}-harness-pw` }
        });
        users[name] = { name, password: `${name}-harness-pw`, jellyfinId: created.Id.replace(/-/g, '').toLowerCase() };
    }

    // Seerr, set up headlessly the way its setup wizard does it.
    const status = await waitFor(`${seerrBase}/api/v1/status`, body => 'version' in body, 180_000, 'Seerr');
    const seerr = new SeerrSession(seerrBase);
    await retry(() => seerr.call('POST', '/api/v1/auth/jellyfin', {
        username: ADMIN.name,
        password: ADMIN.password,
        hostname: 'jellyfin',
        port: 8096,
        useSsl: false,
        urlBase: '',
        email: 'admin@example.com',
        serverType: 2
    }), 10);
    const main = await seerr.call('GET', '/api/v1/settings/main');
    await seerr.call('POST', '/api/v1/settings/initialize').catch(() => {});
    const imported = await seerr.call('POST', '/api/v1/user/import-from-jellyfin', {
        jellyfinUserIds: LINKED_USERS.map(name => users[name].jellyfinId)
    });
    for (const name of LINKED_USERS) {
        const match = imported.find(user => String(user.jellyfinUserId ?? '').replace(/-/g, '').toLowerCase() === users[name].jellyfinId);
        if (!match) {
            throw new Error(`Seerr did not import ${name}: ${JSON.stringify(imported).slice(0, 300)}`);
        }

        users[name].seerrId = match.id;
    }

    const proxyConfig = await jellyfin(base, 'GET', `/Plugins/${PROXY_ID}/Configuration`, { token: adminToken });
    proxyConfig.Enabled = true;
    proxyConfig.SeerrBaseUrl = 'http://seerr:5055';
    proxyConfig.SeerrApiKey = main.apiKey;
    await jellyfin(base, 'POST', `/Plugins/${PROXY_ID}/Configuration`, { token: adminToken, body: proxyConfig });

    return {
        base,
        seerrBase,
        jellyfinVersion: info.Version,
        seerrVersion: `${status.version} (${status.commitTag})`,
        seerrApiKey: main.apiKey,
        adminToken,
        users
    };
}
