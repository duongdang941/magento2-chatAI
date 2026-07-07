import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

export function findLocalValetCa(homeDirectory) {
    const home = String(homeDirectory || '').trim();
    if (!home) return '';

    for (const relativePath of [
        '.config/valet/CA/LaravelValetCASelfSigned.pem',
        '.valet/CA/LaravelValetCASelfSigned.pem'
    ]) {
        const candidate = path.join(home, relativePath);
        if (existsSync(candidate)) return candidate;
    }

    return '';
}

export function localGatewayTlsEnvironment(baseEnvironment = process.env) {
    const environment = { ...baseEnvironment };
    if (environment.TLS_CERT_PATH && environment.TLS_KEY_PATH) {
        return environment;
    }

    const home = String(environment.HOME || homedir()).trim();
    const host = String(environment.MAGENTO_HOST || '').trim().toLowerCase();
    if (!home || !host || !/^[a-z0-9.-]+$/.test(host)) {
        return environment;
    }

    const certificatePath = path.join(home, '.config', 'valet', 'Certificates', `${host}.crt`);
    const privateKeyPath = path.join(home, '.config', 'valet', 'Certificates', `${host}.key`);
    if (existsSync(certificatePath) && existsSync(privateKeyPath)) {
        environment.TLS_CERT_PATH = certificatePath;
        environment.TLS_KEY_PATH = privateKeyPath;
    }

    return environment;
}

export function buildLocalGatewayEnvironment(baseEnvironment = process.env, cwd = process.cwd()) {
    const environment = localGatewayTlsEnvironment(baseEnvironment);
    const magentoBootstrap = path.resolve(cwd, '../../../../../app/bootstrap.php');
    if (!existsSync(magentoBootstrap)) return environment;

    if (!environment.REDIS_URL && !environment.ALLOW_IN_MEMORY_STATE) {
        environment.ALLOW_IN_MEMORY_STATE = 'true';
    }

    // Valet exists only on a local macOS developer machine. Its CA is added
    // to the child Node process automatically when available; production
    // keeps the normal operating-system trust store.
    const valetCa = findLocalValetCa(environment.HOME || homedir());
    if (valetCa && !environment.NODE_EXTRA_CA_CERTS) {
        environment.NODE_EXTRA_CA_CERTS = valetCa;
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
