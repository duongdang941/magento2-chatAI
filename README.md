# Afd_AI

`Afd_AI` is a Magento 2 storefront assistant. Magento owns the storefront,
shopper identity, conversation records, product and order permissions, and all
AI settings. The bundled Node.js gateway provides WebSocket streaming and
provider adapters; it does not expose provider credentials to the browser.

Supported chat providers are Gemini, OpenAI, OpenRouter, 9router, and
OpenAI-compatible Cockpit. Provider selection, API keys, models, voice, image,
tool, rate-limit, and retention settings are configured in Magento Admin and
pushed to the gateway after every save.

## What is installed

```text
Magento storefront
  -> short-lived signed WebSocket ticket
  -> Node.js gateway
  -> selected AI provider

Node.js gateway
  -> signed internal requests
  -> Magento catalog, cart, order, customer, conversation and support services
```

The gateway is deliberately not an alternative source of truth: Magento
revalidates ownership and authorization for every private action.

## Requirements

- A Magento installation with PHP 8.2 or later and the core modules declared
  in [`composer.json`](composer.json).
- Node.js 20 or later (Node 22 is used by the supplied container image).
- npm and a running Magento cron.
- Redis for production. In-memory gateway state is allowed only in local/test
  mode.
- A reachable Node gateway. Production storefronts must use HTTPS/WSS.

`amasty/module-request-a-quote` is optional. The normal Magento checkout flow
works without it.

## 1. Install the Magento module

From the Magento project root, clone this repository into the Magento module
path. The repository root is the module itself, not a complete Magento
project.

```bash
git clone https://github.com/duongdang941/magento2-chatAI.git app/code/Afd/AI

bin/magento module:enable Afd_AI
bin/magento setup:upgrade
bin/magento setup:di:compile
bin/magento setup:static-content:deploy -f
bin/magento cache:clean
```

For a production deployment, run those commands in the normal maintenance
window and ensure Magento cron is active. The module's daily retention cleanup
is scheduled through Magento cron.

Confirm that Magento sees the module:

```bash
bin/magento module:status Afd_AI
```

## 2. Install and run the Node gateway

The Node service is located at `app/code/Afd/AI/ai-chat-server`. Install only
its production dependencies and create its private environment file:

```bash
cd app/code/Afd/AI/ai-chat-server
npm ci --omit=dev
cp .env.gateway.example .env
chmod 600 .env
```

Before starting the gateway, obtain the two Magento-generated shared secrets:

```bash
cd /path/to/magento
bin/magento afd:ai:gateway:credentials
```

Copy both values printed by that command into the gateway `.env`. Every
gateway replica must use the same values.

```dotenv
NODE_ENV=production
PORT=3001

# Startup fallback only. Magento sends the current base URL for every store
# during configuration sync, so do not put a development-only domain here.
MAGENTO_API_URL=https://shop.example.com

# Required in production. Use the authenticated Redis URL supplied by the
# deployment; do not use ALLOW_IN_MEMORY_STATE in production.
REDIS_URL=rediss://:replace-with-redis-password@redis.example.net:6380/0

AI_NODE_SYNC_SECRET=copy-the-value-from-magento-command
AI_WS_TICKET_SECRET=copy-the-value-from-magento-command
AI_METRICS_TOKEN=replace-with-a-separate-long-random-monitoring-token
```

Do **not** put Gemini, OpenAI, OpenRouter, 9router, or Cockpit API keys in the
Node `.env` for normal operation. Magento Admin is the configuration source of
truth and sends the selected provider key to the gateway in an authenticated,
encrypted configuration snapshot.

Start the service with the supplied wrapper:

```bash
cd /path/to/magento/app/code/Afd/AI/ai-chat-server
npm start
```

Use systemd, Supervisor, Kubernetes, or another process manager to keep this
command running and to restart it after a deployment. The service exposes
`/health` (and `/ai-gateway/health` when it is behind the same-origin proxy):

```bash
curl http://127.0.0.1:3001/health
```

The health response is `{"status":"ok"}` only when both the gateway runtime
and its signed Magento connection are healthy.

### Local development

For one local gateway process, a Redis server is optional:

```dotenv
NODE_ENV=development
PORT=3001
MAGENTO_API_URL=https://your-local-store.test
MAGENTO_HOST=your-local-store.test
ALLOW_IN_MEMORY_STATE=true
AI_NODE_SYNC_SECRET=copy-the-value-from-magento-command
AI_WS_TICKET_SECRET=copy-the-value-from-magento-command
```

When the project is served by Laravel Valet, `npm start` automatically uses
the local Valet certificate if it is available. For an HTTPS storefront,
configure the gateway endpoint as `wss://your-local-store.test:3001/`, or
proxy `/ai-gateway/` through the store web server. Do not reuse this local
configuration in production.

## 3. Put the gateway behind the storefront URL

For production, terminate TLS at the existing Magento HTTPS virtual host and
proxy the `/ai-gateway/` path to the Node service. This lets the browser use
the store's own domain and preserves the default CSP policy.

Use the examples under
[`ai-chat-server/infra/nginx`](ai-chat-server/infra/nginx):

1. Adapt `production-upstream.conf.example` with the real gateway hostnames
   and load it in Nginx's `http {}` context.
2. Add the `location /ai-gateway/` block from
   `magento-edge-location.conf.example` to the existing Magento HTTPS virtual
   host.
3. Reload Nginx and confirm `https://shop.example.com/ai-gateway/health`.

There is no Docker Compose file in this repository. To use the supplied
container image, build it from the gateway directory and inject the same
environment values through your deployment platform:

```bash
cd app/code/Afd/AI/ai-chat-server
docker build -f infra/Dockerfile -t afd-ai-gateway:latest .
```

The container must be able to reach both Redis and the public Magento base
URL. Persist the gateway configuration directory or use Redis, so a container
replacement does not discard the last accepted configuration snapshot.

## 4. Configure Magento Admin and synchronize

Open **Content → Store Assistant → Configuration**. Use the configuration
scope that matches the store view you are enabling.

1. In **General Chat**, enable the assistant and choose whether guest history
   is persisted. Leave **Chat Server WebSocket URL** empty when the Nginx
   `/ai-gateway/` proxy is on the store's own domain. Magento then derives the
   correct URL from each store's Base URL. Enter a `ws://` or `wss://` URL only
   for a deliberate direct or separate gateway endpoint.
2. In **AI Provider & Models**, select the provider first. Magento displays
   only that provider's API key and model fields. For Gemini, enter the Gemini
   API key, chat model, Gemini voice dictation model, and (if image generation
   is enabled) Gemini image model.
3. Configure shared limits under **Images & Attachments**, **Voice Dictation
   & Limits**, and **Advanced Operations & Integrations** (including
   **Quality & Tool Budget**, **Shopper Rate Limits**, **Gateway Capacity**,
   **Support Team**, and **Data Retention**) as required. OpenAI Realtime Live
   Voice is shown only for the OpenAI provider; Gemini voice dictation uses
   the Gemini voice model instead.
4. Save the configuration. Magento posts a signed snapshot to the Node
   gateway. Verify **Gateway Security & Sync → Node Configuration Sync
   Status** reports success and shows the selected provider/model.

The Magento base URL is included in every synchronized store snapshot. When a
store domain changes, update Magento's Base URLs and save the Web
configuration; the module synchronizes the new URL. No source-code change or
fixed local hostname is required.

The **Magento OAuth** fields are not required for the standard Node-to-Magento
flow, which uses the generated HMAC credentials above. If a deployment adds a
separate OAuth integration, restrict it to `Afd_AI::chat_gateway`; never grant
`Magento_Backend::all` merely for this module.

## 5. Verify the installation

1. Open a storefront page and confirm the Store Assistant widget appears.
2. Send a short message and confirm the gateway streams a response.
3. Search for a product and verify the returned product cards match Magento
   catalog visibility and pricing.
4. As a guest, reload the page and confirm history remains when **Persist
   Guest Chat History** is enabled.
5. In Admin, verify the node synchronization status remains successful after
   saving a provider setting.

Useful diagnostics:

```bash
# Magento module and schema
bin/magento module:status Afd_AI
bin/magento setup:db:status

# Node automated tests
cd app/code/Afd/AI/ai-chat-server
npm test

# PHP syntax check
cd /path/to/magento
find app/code/Afd/AI -name '*.php' -print0 | xargs -0 -n1 php -l
```

## Updating

```bash
cd /path/to/magento/app/code/Afd/AI
git pull --ff-only origin main

cd /path/to/magento
bin/magento setup:upgrade
bin/magento setup:di:compile
bin/magento setup:static-content:deploy -f
bin/magento cache:clean

cd app/code/Afd/AI/ai-chat-server
npm ci --omit=dev
# Restart the process manager service here.
```

After an update, save the Store Assistant configuration once so the current
Magento settings are synchronized to the restarted gateway.

## Security and operating boundaries

- The browser receives a short-lived, single-use WebSocket ticket, never a
  provider key or Magento service credential.
- New image attachments are stored under `var/afd_ai/chat` and are served only
  after conversation-ownership checks.
- Redis coordinates rate limits, queues, capacity leases, replay prevention,
  and the active configuration across gateway replicas.
- Image uploads are limited to a fully serialized 8 MiB WebSocket frame; the
  default combined base64 budget is 6 MiB, reserving space for history and
  message metadata.
- The private metrics endpoint requires `X-Afd-AI-Metrics-Token` matching
  `AI_METRICS_TOKEN`; do not expose it publicly.

For gateway internals and production scaling requirements, see
[`docs/architecture/SCALABLE_AI_GATEWAY.md`](docs/architecture/SCALABLE_AI_GATEWAY.md).
