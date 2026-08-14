import crypto from 'node:crypto';
import express from 'express';
import { applyPushedConfig } from '../configuration/config-service.js';

const CONFIG_SYNC_TTL_MS = 5 * 60 * 1000;
const HEALTH_CACHE_TTL_MS = 5000;
const SUPPORT_EVENT_TTL_MS = 5 * 60 * 1000;
const GATEWAY_PUBLIC_PREFIX = '/ai-gateway';

function normalizedRequestPath(req) {
    const rawPath = String(req.originalUrl || req.url || req.path || '/');
    try {
        const path = new URL(rawPath, 'http://gateway.internal').pathname.replace(/\/{2,}/g, '/') || '/';
        return path === GATEWAY_PUBLIC_PREFIX
            ? '/'
            : path.startsWith(`${GATEWAY_PUBLIC_PREFIX}/`)
                ? path.slice(GATEWAY_PUBLIC_PREFIX.length)
                : path;
    } catch {
        return '/';
    }
}

function registerGatewayRoute(app, method, path, handler) {
    app[method](path, handler);
    app[method](`${GATEWAY_PUBLIC_PREFIX}${path}`, handler);
}

export function verifyConfigPush(req, secret = process.env.AI_NODE_SYNC_SECRET || '') {
    const timestamp = req.get('X-Afd-AI-Timestamp') || '';
    const signature = req.get('X-Afd-AI-Signature') || '';
    const requestTime = Number(timestamp);
    const now = Math.floor(Date.now() / 1000);

    if (secret.length < 32
        || !Number.isInteger(requestTime)
        || Math.abs(now - requestTime) > 300
        || !/^[a-f0-9]{64}$/i.test(signature)) {
        return false;
    }

    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${String(req.method || 'POST').toUpperCase()}.${normalizedRequestPath(req)}.${req.rawBody || ''}`, 'utf8')
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
    );
}

export function registerGatewayHttpRoutes({
    app,
    runtime,
    metrics,
    db,
    websocketConnections,
    broadcastSupportMessage = () => 0,
    broadcastSupportMutation = () => 0,
    broadcastSupportMode = () => 0,
    revokeSession = () => 0,
    onConfigAccepted = () => {},
    metricsToken = process.env.AI_METRICS_TOKEN || '',
    syncSecret = process.env.AI_NODE_SYNC_SECRET || ''
}) {
    let healthSnapshot = { expiresAt: 0, healthy: false };

    app.use(express.json({
        limit: '1mb',
        verify: (req, res, buffer) => {
            req.rawBody = buffer.toString('utf8');
        }
    }));

    const healthHandler = async (req, res) => {
        const now = Date.now();
        if (healthSnapshot.expiresAt <= now) {
            const [magentoOk, runtimeHealth] = await Promise.all([
                db.pingMagento(),
                Promise.resolve(runtime.getHealth())
            ]);
            healthSnapshot = {
                healthy: magentoOk && runtimeHealth.connected,
                expiresAt: now + HEALTH_CACHE_TTL_MS
            };
        }

        res.status(healthSnapshot.healthy ? 200 : 503).json({
            status: healthSnapshot.healthy ? 'ok' : 'degraded'
        });
    };
    registerGatewayRoute(app, 'get', '/health', healthHandler);

    const metricsHandler = async (req, res) => {
        if (!metricsToken || req.get('X-Afd-AI-Metrics-Token') !== metricsToken) {
            res.status(404).end();
            return;
        }
        res.type('text/plain; version=0.0.4; charset=utf-8');
        res.send(await metrics.toPrometheus({
            runtime,
            websocketConnections: websocketConnections()
        }));
    };
    registerGatewayRoute(app, 'get', '/internal/metrics', metricsHandler);

    const configHandler = async (req, res) => {
        if (!verifyConfigPush(req, syncSecret)) {
            res.status(401).json({ status: 'error', message: 'Invalid configuration sync signature.' });
            return;
        }

        try {
            if (![1, 2].includes(Number(req.body?.version)) || !req.body?.sync_id) {
                res.status(400).json({ status: 'error', message: 'Invalid configuration sync payload.' });
                return;
            }

            const syncId = String(req.body.sync_id);
            if (!/^[a-f0-9]{32}$/i.test(syncId)
                || !await runtime.claimOnce('config-sync', syncId, CONFIG_SYNC_TTL_MS)) {
                res.status(409).json({ status: 'error', message: 'Configuration sync request was already used.' });
                return;
            }

            const snapshot = await applyPushedConfig(req.body.config, runtime);
            await Promise.resolve(onConfigAccepted(snapshot));
            const config = snapshot.default;
            res.json({
                status: 'ok',
                message: 'Node accepted the configuration.',
                sync_id: syncId,
                provider: config.provider,
                model: config.model,
                capabilities: config.capabilities,
                warnings: snapshot.validation?.warnings || [],
                store_count: Object.keys(snapshot.stores || {}).length,
                applied_at: new Date().toISOString()
            });
        } catch (error) {
            res.status(Number(error?.status) || 500).json({
                status: 'error',
                message: error.message || 'Could not apply configuration.'
            });
        }
    };
    registerGatewayRoute(app, 'post', '/internal/config', configHandler);

    const sessionRevokeHandler = async (req, res) => {
        if (!verifyConfigPush(req, syncSecret)) {
            res.status(401).json({ status: 'error', message: 'Invalid session revocation signature.' });
            return;
        }

        const payload = req.body || {};
        const eventId = String(payload.event_id || '');
        const sessionHash = String(payload.session_hash || '').toLowerCase();
        const customerId = Math.max(0, Math.trunc(Number(payload.customer_id) || 0));
        if (payload.version !== 1
            || !/^[a-f0-9]{32}$/i.test(eventId)
            || !/^[a-f0-9]{64}$/.test(sessionHash)) {
            res.status(400).json({ status: 'error', message: 'Invalid session revocation payload.' });
            return;
        }
        if (!await runtime.claimOnce('session-revoke', eventId, CONFIG_SYNC_TTL_MS)) {
            res.status(409).json({ status: 'error', message: 'Session revocation request was already used.' });
            return;
        }

        const closed = await Promise.resolve(revokeSession({ sessionHash, customerId }));
        res.json({ status: 'ok', event_id: eventId, closed: Math.max(0, Number(closed) || 0) });
    };
    registerGatewayRoute(app, 'post', '/internal/session-revoke', sessionRevokeHandler);

    const catalogInvalidateHandler = async (req, res) => {
        if (!verifyConfigPush(req, syncSecret)) {
            res.status(401).json({ status: 'error', message: 'Invalid catalogue invalidation signature.' });
            return;
        }
        const payload = req.body || {};
        const eventId = String(payload.event_id || '');
        if (payload.version !== 1 || !/^[a-f0-9]{32}$/i.test(eventId)) {
            res.status(400).json({ status: 'error', message: 'Invalid catalogue invalidation payload.' });
            return;
        }
        if (!await runtime.claimOnce('catalog-invalidate', eventId, CONFIG_SYNC_TTL_MS)) {
            res.status(409).json({ status: 'error', message: 'Catalogue invalidation request was already used.' });
            return;
        }
        const version = typeof runtime.bumpCacheVersion === 'function'
            ? await runtime.bumpCacheVersion('catalog')
            : 0;
        res.json({ status: 'ok', event_id: eventId, catalog_version: version });
    };
    registerGatewayRoute(app, 'post', '/internal/catalog-invalidate', catalogInvalidateHandler);

    const supportMessageHandler = async (req, res) => {
        if (!verifyConfigPush(req, syncSecret)) {
            res.status(401).json({ status: 'error', message: 'Invalid support notification signature.' });
            return;
        }

        const payload = req.body || {};
        const eventId = String(payload.event_id || '');
        const conversationId = Math.trunc(Number(payload.conversation_id) || 0);
        const customerId = Math.trunc(Number(payload.customer_id) || 0);
        const guestId = String(payload.guest_id || '').toLowerCase();
        const messageId = Math.trunc(Number(payload.message_id) || 0);
        const validIdentity = customerId > 0
            ? guestId === ''
            : /^[a-f0-9]{64}$/.test(guestId);

        if (payload.version !== 1
            || !/^[a-f0-9]{32}$/i.test(eventId)
            || conversationId < 1
            || messageId < 1
            || !validIdentity) {
            res.status(400).json({ status: 'error', message: 'Invalid support notification payload.' });
            return;
        }
        if (!await runtime.claimOnce('support-message', eventId, SUPPORT_EVENT_TTL_MS)) {
            res.status(409).json({ status: 'error', message: 'Support notification was already used.' });
            return;
        }

        const recipients = await Promise.resolve(broadcastSupportMessage({
            conversationId,
            customerId,
            guestId,
            messageId
        }));
        res.json({ status: 'ok', event_id: eventId, recipients: Math.max(0, Number(recipients) || 0) });
    };
    registerGatewayRoute(app, 'post', '/internal/support-message', supportMessageHandler);

    const supportModeHandler = async (req, res) => {
        if (!verifyConfigPush(req, syncSecret)) {
            res.status(401).json({ status: 'error', message: 'Invalid support mode signature.' });
            return;
        }
        const payload = req.body || {};
        const eventId = String(payload.event_id || '');
        const conversationId = Math.trunc(Number(payload.conversation_id) || 0);
        const customerId = Math.trunc(Number(payload.customer_id) || 0);
        const guestId = String(payload.guest_id || '').toLowerCase();
        const validIdentity = customerId > 0 ? guestId === '' : /^[a-f0-9]{64}$/.test(guestId);
        if (payload.version !== 1 || !/^[a-f0-9]{32}$/i.test(eventId) || conversationId < 1 || !validIdentity) {
            res.status(400).json({ status: 'error', message: 'Invalid support mode payload.' });
            return;
        }
        if (!await runtime.claimOnce('support-mode', eventId, SUPPORT_EVENT_TTL_MS)) {
            res.status(409).json({ status: 'error', message: 'Support mode notification was already used.' });
            return;
        }
        const recipients = await Promise.resolve(broadcastSupportMode({
            conversationId,
            customerId,
            guestId,
            active: payload.active === true,
            agentLabel: String(payload.agent_label || '').slice(0, 80)
        }));
        res.json({ status: 'ok', event_id: eventId, recipients: Math.max(0, Number(recipients) || 0) });
    };
    registerGatewayRoute(app, 'post', '/internal/support-mode', supportModeHandler);

    const supportMessageMutationHandler = async (req, res) => {
        if (!verifyConfigPush(req, syncSecret)) {
            res.status(401).json({ status: 'error', message: 'Invalid support mutation signature.' });
            return;
        }
        const payload = req.body || {};
        const eventId = String(payload.event_id || '');
        const conversationId = Math.trunc(Number(payload.conversation_id) || 0);
        const customerId = Math.trunc(Number(payload.customer_id) || 0);
        const guestId = String(payload.guest_id || '').toLowerCase();
        const messageId = Math.trunc(Number(payload.message_id) || 0);
        const operation = String(payload.operation || '');
        const validIdentity = customerId > 0 ? guestId === '' : /^[a-f0-9]{64}$/.test(guestId);
        if (payload.version !== 1
            || !/^[a-f0-9]{32}$/i.test(eventId)
            || conversationId < 1
            || messageId < 1
            || !['edit', 'delete'].includes(operation)
            || !validIdentity) {
            res.status(400).json({ status: 'error', message: 'Invalid support mutation payload.' });
            return;
        }
        if (!await runtime.claimOnce('support-message-mutation', eventId, SUPPORT_EVENT_TTL_MS)) {
            res.status(409).json({ status: 'error', message: 'Support mutation notification was already used.' });
            return;
        }
        const recipients = await Promise.resolve(broadcastSupportMutation({
            conversationId,
            customerId,
            guestId,
            messageId,
            operation,
            content: String(payload.content || '').slice(0, 4000),
            editedAt: String(payload.edited_at || ''),
            deletedAt: String(payload.deleted_at || '')
        }));
        res.json({ status: 'ok', event_id: eventId, recipients: Math.max(0, Number(recipients) || 0) });
    };
    registerGatewayRoute(app, 'post', '/internal/support-message-mutation', supportMessageMutationHandler);
}
