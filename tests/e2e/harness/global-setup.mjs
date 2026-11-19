import { join } from 'node:path';
import { HARNESS_ROOT, JELLYFIN_IMAGE, SEERR_IMAGE, startStack, stopStack } from './stack.mjs';

// Builds the plugin, boots Jellyfin and Seerr with everything linked, and hands the addresses,
// the users and Seerr's API key to the tests through the environment.
export default async function globalSetup() {
    const started = Date.now();
    const stack = await startStack();
    process.env.SEERR_INTEGRATION_E2E = JSON.stringify(stack);

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`Jellyfin ${stack.jellyfinVersion} (${JELLYFIN_IMAGE}) at ${stack.base}`);
    console.log(`Seerr ${stack.seerrVersion} (${SEERR_IMAGE}) at ${stack.seerrBase}`);
    console.log(`Ready in ${seconds}s`);

    return async () => {
        if (process.env.HARNESS_KEEP) {
            console.log(`HARNESS_KEEP set: left running. Jellyfin ${stack.base} (admin / harness-admin-pw), Seerr ${stack.seerrBase}.`);
            console.log('Remove with: docker rm -f -v seerr-integration-e2e-jellyfin seerr-integration-e2e-seerr && docker network rm seerr-integration-e2e');
            return;
        }

        await stopStack({ logDir: join(HARNESS_ROOT, 'test-results') });
    };
}
