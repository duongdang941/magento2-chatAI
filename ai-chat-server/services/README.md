# Service directory map

Services are grouped by business responsibility. Keep new files in the narrowest matching directory and import them directly from that location.

| Directory | Responsibility |
| --- | --- |
| `catalog/` | Product search, catalogue scope, pagination, page context and product presentation |
| `configuration/` | Runtime configuration, sealed snapshots and local Magento bootstrap |
| `conversation/` | Message contracts, history, streaming, interruption and response processing |
| `customer/` | Cart, customer address, customer order and guest order workflows |
| `gateway/` | Magento transport, persistence client, runtime state, metrics and HTTP routes |
| `media/` | Image generation and native web search |
| `orchestration/` | Provider-independent agent guidance, provider orchestration and execution budgets |
| `providers/` | Thin provider adapters selected by the orchestrator factory |
| `security/` | WebSocket authentication, authorization, ticket validation and session revocation |
| `support/` | Human-support event broadcasting |
| `tools/` | Canonical tool registry and shared Magento tool execution |

Cross-domain modules should depend on these domain paths directly. Avoid adding JavaScript files back to the `services/` root.
