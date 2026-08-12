import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function buildLocalGatewayEnvironment(baseEnvironment = process.env, cwd = process.cwd()) {
    const environment = { ...baseEnvironment };
    const magentoBootstrap = path.resolve(cwd, '../../../../../app/bootstrap.php');
    if (!existsSync(magentoBootstrap)) return environment;

    if (!environment.REDIS_URL && !environment.ALLOW_IN_MEMORY_STATE) {
        environment.ALLOW_IN_MEMORY_STATE = 'true';
    }

    try {
        // In a local Magento checkout, Admin configuration is the source of
        // truth. Always prefer its current secrets over a copied/stale .env
        // file; production replicas do not have this local bootstrap path and
        // continue to use injected environment secrets.
        const magentoSyncSecret = readMagentoSecret(
            magentoBootstrap,
            'getNodeSyncSecret',
            environment,
            cwd
        );
        if (magentoSyncSecret.length >= 32) {
            environment.AI_NODE_SYNC_SECRET = magentoSyncSecret;
        }

        const magentoTicketSecret = readMagentoSecret(
            magentoBootstrap,
            'getWebSocketTicketSecret',
            environment,
            cwd
        );
        if (magentoTicketSecret.length >= 32) {
            environment.AI_WS_TICKET_SECRET = magentoTicketSecret;
        }
    } catch {
        // Production injects secrets. The gateway will emit its normal safe
        // startup error if neither environment nor local Magento can provide them.
    }

    return environment;
}

function readMagentoSecret(bootstrapFile, method, environment, cwd) {
    const php = [
        'require getenv("AFD_AI_MAGENTO_BOOTSTRAP");',
        '$bootstrap = Magento\\Framework\\App\\Bootstrap::create(BP, $_SERVER);',
        '$config = $bootstrap->getObjectManager()->get(Afd\\AI\\Model\\Config\\Config::class);',
        '$method = getenv("AFD_AI_CONFIG_METHOD");',
        'echo $config->$method();'
    ].join('');

    return execFileSync('php', ['-r', php], {
        cwd,
        encoding: 'utf8',
        env: {
            ...environment,
            AFD_AI_MAGENTO_BOOTSTRAP: bootstrapFile,
            AFD_AI_CONFIG_METHOD: method
        },
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}
