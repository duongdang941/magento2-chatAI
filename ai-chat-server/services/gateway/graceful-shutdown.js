/**
 * Stop HTTP/WebSocket admission without waiting indefinitely for a browser
 * that has an open chat socket. This is used for deploys and local restarts.
 */
export async function stopGateway({ server, wss, runtime }) {
    for (const socket of wss.clients) {
        try {
            socket.close(1001, 'Gateway restarting');
            setTimeout(() => socket.terminate(), 1500).unref();
        } catch {
            // A socket can disappear while the shutdown loop is running.
        }
    }
    await new Promise((resolve) => server.close(resolve));
    await runtime.disconnect();
}
