import 'dotenv/config';
import { spawn } from 'node:child_process';
import { buildLocalGatewayEnvironment } from '../services/local-magento-bootstrap.js';

const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: buildLocalGatewayEnvironment(),
    stdio: 'inherit'
});

let forwardedShutdownSignal = '';

// launchd signals this wrapper, not its child process group. Forward graceful
// shutdown to the actual gateway so a restart cannot leave an orphaned
// server.js process holding stale in-memory state or the WebSocket port.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
        forwardedShutdownSignal = signal;
        if (!child.killed) {
            child.kill(signal);
        }
    });
}

child.once('exit', (code, signal) => {
    if (forwardedShutdownSignal) {
        process.exit(0);
    }

    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});
