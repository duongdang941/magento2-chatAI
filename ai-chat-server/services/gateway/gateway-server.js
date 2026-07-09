import fs from 'node:fs';
import http from 'http';
import https from 'https';

/**
 * Create the gateway transport. A deployment can terminate TLS at a reverse
 * proxy, or supply a certificate directly when the public WebSocket endpoint
 * is served by this Node process (such as a local Valet HTTPS site).
 */
export function createGatewayServer(application, environment = process.env) {
    const certificatePath = String(environment.TLS_CERT_PATH || '').trim();
    const privateKeyPath = String(environment.TLS_KEY_PATH || '').trim();

    if (!certificatePath && !privateKeyPath) {
        return http.createServer(application);
    }

    if (!certificatePath || !privateKeyPath) {
        throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be configured together.');
    }

    return https.createServer({
        cert: fs.readFileSync(certificatePath),
        key: fs.readFileSync(privateKeyPath)
    }, application);
}
