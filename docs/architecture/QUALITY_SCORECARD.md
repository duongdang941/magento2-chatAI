# Afd_AI quality scorecard

Assessment date: 2026-08-11

## Result

Weighted overall score: **9.1/10**.

| Area | Weight | Score | Evidence |
| --- | ---: | ---: | --- |
| Architecture and boundaries | 30% | 9.0 | Provider adapters use one tool registry/executor; Magento remains the commerce and authorization authority; history hydration, support broadcasting, address admission, runtime config, and frontend state are extracted services. |
| Security and privacy | 25% | 9.3 | Single-use tickets/nonces, HMAC internal endpoints, default-deny WebSocket actions, origin validation, scoped ACL, encrypted runtime snapshots, private attachments, ownership enforcement, OTP/rate limits, and tested deletion/redaction. |
| Reliability and testability | 25% | 9.4 | 164 Node tests, 22 PHPUnit tests/70 assertions, 14 shopping-contract checks, 50/50 model-grounding evaluation, browser regression, integration smoke, linting, DI compilation, and provider retry before first output only. |
| Code quality and Magento conventions | 10% | 8.8 | Declarative schema/service contracts/DI, `.less` sources, PHP strict types, zero PHPCS errors, and architecture regression budgets. Some large feature modules remain. |
| Operations and maintainability | 10% | 9.0 | Admin-owned runtime config, sealed snapshots, health endpoint, dependency audit, explicit deployment steps, bounded queues/timeouts, and reproducible evaluation reports. |

## Verified invariants

- `Afd AI Gateway (Local)` has only `Afd_AI::chat_gateway` permission.
- Database contains zero orphan chat messages and zero orphan support-case conversations.
- The runtime config snapshot is AES-256-GCM sealed, contains no plaintext credentials, and is permissioned `0600`.
- A disabled or absent exact product never produces unrelated product cards in the 20 negative ground-truth cases.
- Active exact and typo product identities pass all 25 positive ground-truth cases.
- History loading restores the guest transcript without leaving the blocking overlay visible.

## Remaining work before 10/10

- Split `view/frontend/web/js/chat/stream.js` into smaller access, address, media/catalogue, mutation, and stream-event feature modules.
- Replace base64 image frames with authenticated HTTP upload plus short-lived attachment IDs for lower memory amplification.
- Continue reducing legacy PHPCS warnings, mainly missing docblocks and line-length warnings; there are no current PHPCS errors.
- Add Redis-backed multi-replica staging load tests and chaos tests for provider/Redis/Magento partial outages.
