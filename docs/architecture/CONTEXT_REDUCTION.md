# Model context reduction

`Afd_AI` reduces provider input at two boundaries while keeping Magento and
the stored conversation as the source of truth.

## Tool result boundary

`ai-chat-server/services/orchestration/tool-context-reducer.js` creates a
provider-only view of each result. It removes UI-only form schemas and HTML,
deduplicates stable identities, retains catalogue coverage and commerce
eligibility facts, and enforces a final byte-derived token budget.

The raw result still drives authorization outcomes, customer forms, product
presentation, tool activity and persistence. A reducer is never an
authorization boundary. When reduction fails or produces a larger payload,
the raw provider payload is used (`never worse`).

Both OpenAI-compatible providers (including Cockpit) and Gemini use this same
service; provider adapters must not implement separate commerce reducers.

## Conversation boundary

`ai-chat-server/services/conversation/conversation-history.js` keeps recent
messages newest-first within both the Admin message limit and the approximate
token budget. It preserves the latest structured `CATALOG_CONTEXT:v2` memory
once, instead of repeating every old product grid. Full history remains in
Magento/guest history for display and audit.

The estimate uses UTF-8 bytes divided by four. This is deterministic and
provider-neutral, but it is not a billing tokenizer. Production metrics expose
raw and provider-view bytes independently.

## Configuration

Admin → Afd Extensions → Agent Behaviour → Quality & Tool Budget:

- Conversation History Token Budget (`512–64000`, default `12000`)
- Tool Result Token Budget (`256–24000`, default `6000`)

Saving the section pushes both values through the signed Magento-to-Node
configuration snapshot.

## Verification

Run from `ai-chat-server`:

```bash
npm test
npm run quality:gate
npm run benchmark:context
npm run test:integration
```

The benchmark always reports authoritative UTF-8 byte counts and labels token
counts as estimates. It includes representative, stress and short/long history
profiles so a large synthetic address form cannot be mistaken for normal
request savings.
