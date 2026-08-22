# Afd_AI quality scorecard

Assessment date: 2026-08-20

## Result

Weighted overall score: **9.3/10**.

| Area | Weight | Score | Evidence |
| --- | ---: | ---: | --- |
| Architecture and boundaries | 30% | 9.2 | Provider adapters use one tool registry/executor; Magento remains the commerce and authorization authority; guest history sync and verified guest/support access are isolated services; the gateway composition root is now 1,635 lines and guarded by a regression budget. |
| Security and privacy | 25% | 9.5 | Single-use tickets/nonces, HMAC internal endpoints, default-deny WebSocket actions, origin validation, scoped ACL, encrypted runtime snapshots/API keys, private attachments, provider error redaction, endpoint/IP validation, ownership enforcement, OTP/rate limits, and tested deletion/redaction. |
| Reliability and testability | 25% | 9.5 | 308 Node tests, 83 PHPUnit tests/256 assertions, provider health/circuit tests, 14 shopping-contract checks, model-grounding evaluations, in-app storefront regression, Admin HTTP/static verification, integration smoke, linting, DI compilation, and bounded provider retry/error paths. |
| Code quality and Magento conventions | 10% | 9.0 | Declarative schema/service contracts/DI, `.less` sources, PHP strict types, zero PHPCS errors, PHPStan clean, DOM-safe Admin rendering, and architecture regression budgets. Some large feature modules remain. |
| Operations and maintainability | 10% | 9.2 | Admin-owned runtime config, sealed snapshots, provider health probe/circuit state, dependency audit, explicit PHP 8.3 deployment steps, bounded queues/timeouts, cache/static deploy verification, and reproducible quality-gate output. |

## Verified invariants

- `Afd AI Gateway (Local)` has only `Afd_AI::chat_gateway` permission.
- Database contains zero orphan chat messages and zero orphan support-case conversations.
- The runtime config snapshot is AES-256-GCM sealed, contains no plaintext credentials, and is permissioned `0600`.
- A disabled or absent exact product never produces unrelated product cards in the 20 negative ground-truth cases.
- Active exact and typo product identities pass all 25 positive ground-truth cases.
- History loading restores the guest transcript without leaving the blocking overlay visible.
- Provider health probes validate only the endpoint, use bounded timeouts, clear shared Curl headers, and never return upstream response bodies.
- OpenAI-compatible and Anthropic failures are normalized to stable public error codes without leaking HTML or provider payloads.
- Guest order/support access is capped and restored through owner-scoped shared cache; invalid cached tokens are deleted before protected calls.
- Admin provider notices use the shared styled notice instead of native `alert()` dialogs, and hidden model fields are created through DOM APIs.

## Remaining work before 10/10

- Split `view/frontend/web/js/chat/stream.js` into smaller access, address, media/catalogue, mutation, and stream-event feature modules.
- Replace base64 image frames with authenticated HTTP upload plus short-lived attachment IDs for lower memory amplification.
- Continue reducing legacy PHPCS warnings, mainly missing docblocks and line-length warnings; there are no current PHPCS errors.
- Add Redis-backed multi-replica staging load tests and chaos tests for provider/Redis/Magento partial outages.
