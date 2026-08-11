# Afd_AI

Magento 2 storefront assistant with a Node.js streaming gateway, Magento-owned commerce tools, durable customer/guest history, image generation, and human-support takeover.

## Architecture

The browser never receives provider or Magento integration credentials. Its short-lived, single-use WebSocket ticket contains only an identity claim. The gateway streams model output, but every catalog, cart, customer, order, address, privacy, and support authorization decision remains in Magento.

```text
Storefront (Alpine feature modules)
  -> versioned WebSocket contract
Gateway transport / application runner
  -> provider adapter
  -> canonical tool registry + shared Magento executor
Magento service contracts / ownership policies
  -> repositories and declarative schema
```

Important boundaries:

- `ai-chat-server/services/providers/`: provider protocol adapters only.
- `ai-chat-server/services/tools/tool-registry.js`: canonical schemas and risk policies.
- `ai-chat-server/services/tools/magento-tool-executor.js`: provider-neutral tool execution.
- `ai-chat-server/services/history-message-preparer.js`: secure structured-history hydration and expired-form redaction.
- `Model/Security`, `Model/Order`, `Model/Privacy`: Magento authorization and privacy policies.
- `Model/Cart/OptionalQuoteCartAdapter.php`: the only optional Amasty Request Quote boundary.
- `view/frontend/web/js/chat/state.js`: grouped initial UI state; feature behavior remains in `chat/*.js`.

## Runtime requirements

- PHP 8.2 and Magento 2 modules declared in `composer.json`/`etc/module.xml`.
- Node.js 20+ for the gateway.
- Redis is required outside explicit local/test in-memory mode.
- Alpine is supplied by the active Hyvä storefront theme.
- Amasty Request a Quote is optional. Normal checkout remains available without it.

Provider and OAuth secrets are encrypted before the gateway writes a local snapshot or Redis value. Configure `AI_CONFIG_ENCRYPTION_KEY` or the existing 32+ character `AI_NODE_SYNC_SECRET`. Files are permissioned `0600`; Redis must also use authentication, private networking, and encrypted backups.

## Security invariants

- Integration ACL is limited to `Afd_AI::chat_gateway`; never grant `Magento_Backend::all`.
- Anonymous-looking internal REST endpoints call `NodeRequestAuthorizer` and require timestamped HMAC + nonce replay protection.
- Customer and guest ownership is rechecked in Magento for every private resource.
- Guest OTP is limited by email hash, stable session, network identity, and a global delivery budget.
- WebSocket actions use a default-deny allowlist, exact browser-origin validation in production, bounded frames, and heartbeat termination.
- New chat attachments live under `var/afd_ai/chat` and are served only after conversation ownership validation.
- Privacy deletion removes messages before conversations, cascades feedback, redacts retained support cases, and removes attachment directories.

## Verification

From the Magento root:

```bash
vendor/bin/phpunit -c dev/tests/unit/phpunit.xml.dist app/code/Afd/AI/Test/Unit
find app/code/Afd/AI -name '*.php' -print0 | xargs -0 -n1 php -l
bin/magento setup:db:status
```

From `ai-chat-server`:

```bash
npm test
npm audit --omit=dev
npm run test:integration
npm run validate:shopping
node scripts/evaluate-product-grounding.mjs --limit=50 --concurrency=3
```

Architecture regression tests prohibit provider-specific Magento execution, direct optional-extension coupling, unversioned schema regressions, and a return to the former server/state composition monoliths.

## Deployment

After source changes, run `setup:upgrade`, DI compilation, static content deployment for the target locales, cache clean, and restart the gateway. Push Admin configuration once after upgrading so legacy plaintext gateway snapshots are rewritten as authenticated AES-256-GCM envelopes.
