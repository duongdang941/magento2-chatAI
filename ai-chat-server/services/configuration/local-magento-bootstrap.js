import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

// Magento currently generates hexadecimal credentials, but older synced
// installations can legitimately hold a printable random secret. The gateway
// verifier accepts any sufficiently long secret, so the local bootstrap must
// not silently discard a safe existing WebSocket secret merely because it is
// not hexadecimal.
const GATEWAY_SECRET_PATTERN = /^[\x21-\x7E]{32,256}$/;
const MAGENTO_BOOTSTRAP_ERROR_REPORTING = '8191';

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
        const secrets = readMagentoSecrets(magentoBootstrap, environment, cwd);
        if (isGatewaySecret(secrets.nodeSyncSecret)) {
            environment.AI_NODE_SYNC_SECRET = secrets.nodeSyncSecret;
        }
        if (isGatewaySecret(secrets.webSocketTicketSecret)) {
            environment.AI_WS_TICKET_SECRET = secrets.webSocketTicketSecret;
        }
    } catch {
        // Production injects secrets. The gateway will emit its normal safe
        // startup error if neither environment nor local Magento can provide them.
    }

    return environment;
}

function readMagentoSecrets(bootstrapFile, environment, cwd) {
    const php = [
        'require getenv("AFD_AI_MAGENTO_BOOTSTRAP");',
        '$bootstrap = Magento\\Framework\\App\\Bootstrap::create(BP, $_SERVER);',
        '$config = $bootstrap->getObjectManager()->get(Afd\\AI\\Model\\Config\\Config::class);',
        'echo json_encode([',
        '"node_sync_secret" => $config->getNodeSyncSecret(),',
        '"ws_ticket_secret" => $config->getWebSocketTicketSecret()',
        '], JSON_THROW_ON_ERROR);'
    ].join('');

    for (const phpBinary of phpBinaryCandidates(environment)) {
        try {
            const output = execFileSync(phpBinary, magentoBootstrapPhpArguments(php), {
                cwd,
                encoding: 'utf8',
                env: {
                    ...environment,
                    AFD_AI_MAGENTO_BOOTSTRAP: bootstrapFile
                },
                stdio: ['ignore', 'pipe', 'pipe']
            }).trim();

            const parsed = JSON.parse(output);
            const nodeSyncSecret = String(parsed?.node_sync_secret || '').trim();
            const webSocketTicketSecret = String(parsed?.ws_ticket_secret || '').trim();
            if (isGatewaySecret(nodeSyncSecret) && isGatewaySecret(webSocketTicketSecret)) {
                return { nodeSyncSecret, webSocketTicketSecret };
            }
        } catch {
            // The shell's PHP can be newer than the PHP version configured
            // for this Valet site. Try a locally installed, compatible PHP
            // binary before treating the bootstrap as unavailable.
        }
    }

    return { nodeSyncSecret: '', webSocketTicketSecret: '' };
}

function phpBinaryCandidates(environment) {
    const candidates = [
        environment.AFD_AI_PHP_BINARY,
        environment.PHP_BINARY,
        'php'
    ];

    // Homebrew commonly keeps the CLI's newest PHP selected globally while
    // a Valet Magento site remains pinned to an earlier supported release.
    // Discover those installed versions instead of hard-coding one version.
    for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
        try {
            const versions = readdirSync(prefix)
                .filter((entry) => /^php@\d+\.\d+$/.test(entry))
                .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
            for (const version of versions) {
                const binary = path.join(prefix, version, 'bin', 'php');
                if (existsSync(binary)) candidates.push(binary);
            }
        } catch {
            // This is not a Homebrew development machine.
        }
    }

    return [...new Set(candidates.filter((candidate) => typeof candidate === 'string' && candidate.trim() !== ''))];
}

/**
 * Magento emits PHP deprecation notices in some local developer runtimes.
 * A gateway credential bootstrap must produce exactly one secret on stdout;
 * otherwise the warning text can be mistaken for a credential or exceed the
 * child-process output limit before the gateway starts.
 */
export function magentoBootstrapPhpArguments(program) {
    return [
        '-d', 'display_errors=0',
        '-d', `error_reporting=${MAGENTO_BOOTSTRAP_ERROR_REPORTING}`,
        '-r', program
    ];
}

export function isGatewaySecret(value) {
    return GATEWAY_SECRET_PATTERN.test(String(value || '').trim());
}
