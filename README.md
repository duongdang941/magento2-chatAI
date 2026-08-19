# Magento 2 AI Assistant & Support Gateway (Afd_AI)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PHP 8.2+](https://img.shields.io/badge/PHP-8.2%2B-blue.svg)](https://www.php.net)
[![Magento 2.4](https://img.shields.io/badge/Magento-2.4%2B-orange.svg)](https://magento.com)
[![Hyvä Theme](https://img.shields.io/badge/Theme-Hyv%C3%A4-green.svg)](https://hyva.io)
[![CI](https://github.com/duongdang941/magento2-chatAI/actions/workflows/ci.yml/badge.svg)](https://github.com/duongdang941/magento2-chatAI/actions)

An open-source, enterprise-ready **AI Storefront Assistant and Human Support Gateway** for Magento 2 and Hyvä Themes. Features real-time bidirectional WebSocket streaming, native Magento commerce tools (catalog grounding, cart mutations, guest order access, order fulfillment), multi-model provider support (OpenAI, Gemini), and seamless human agent handover.

---

## ✨ Key Features

- **Real-Time Streaming**: High-performance Node.js WebSocket gateway with chunk buffering, step-by-step thinking progress, and responsive token delivery.
- **Provider Neutral Architecture**: Pluggable adapters for **OpenAI (GPT-4o, GPT-5)**, **Google Gemini**, and local/custom OpenAI-compatible models.
- **Native Commerce Tools**:
  - Semantic & keyword catalog search with HTML product cards.
  - Live stock and variant checking.
  - Direct shopping cart and Quote Cart (*Anfrage-Zettel*) operations.
  - Customer order lookup, fulfillment tracking, and address update forms.
  - Secure guest order verification via email OTP.
- **Human Support Portal**: Verified ticket routing and real-time live support takeover between customer and admin agents.
- **Hyvä Storefront UI**: Lightweight Alpine.js modular frontend components with dark mode, image upload & vision analysis, voice input, and multi-language i18n support.
- **Robust Security**: HMAC request signing, integration ACL isolation, encrypted Redis snapshots, and strict data privacy deletion cascading.

---

## 🏗️ Architecture

The browser never receives provider or Magento integration credentials. Its short-lived, single-use WebSocket ticket contains only an identity claim. The gateway streams model output, but every catalog, cart, customer, order, address, privacy, and support authorization decision remains securely in Magento.

```text
Storefront (Alpine feature modules)
  -> versioned WebSocket contract
Gateway transport / application runner
  -> provider adapter (OpenAI / Gemini)
  -> canonical tool registry + shared Magento executor
Magento service contracts / ownership policies
  -> repositories and declarative schema
```

### Important boundaries:

- `ai-chat-server/services/providers/`: provider protocol adapters only.
- `ai-chat-server/services/tools/tool-registry.js`: canonical schemas and risk policies.
- `ai-chat-server/services/tools/magento-tool-executor.js`: provider-neutral tool execution.
- `ai-chat-server/services/conversation/history-message-preparer.js`: secure structured-history hydration and expired-form redaction.
- `Model/Security`, `Model/Order`, `Model/Privacy`: Magento authorization and privacy policies.
- `Model/Cart/OptionalQuoteCartAdapter.php`: the only optional Amasty Request Quote boundary.
- `view/frontend/web/js/chat/state.js`: grouped initial UI state; feature behavior remains in `chat/*.js`.

---

## 💻 Runtime Requirements

- **PHP**: 8.2+ with Magento 2.4.x.
- **Node.js**: 20+ for the streaming gateway.
- **Redis**: 6.2+ (required outside explicit local/test in-memory mode).
- **Theme**: Hyvä Theme (Alpine.js & Tailwind CSS).
- **Optional**: Amasty Request a Quote (supported via optional adapter).

---

## 🔒 Security Invariants

- Integration ACL is limited to `Afd_AI::chat_gateway`; never grant `Magento_Backend::all`.
- Provider API keys and Magento OAuth credentials use Magento encrypted configuration storage at rest.
- Anonymous-looking internal REST endpoints call `NodeRequestAuthorizer` and require timestamped HMAC + nonce replay protection.
- Customer and guest ownership is rechecked in Magento for every private resource.
- Guest OTP is limited by email hash, stable session, network identity, and a global delivery budget.
- WebSocket actions use a default-deny allowlist, exact browser-origin validation in production, bounded frames, and heartbeat termination.
- New chat attachments live under `var/afd_ai/chat` and are served only after conversation ownership validation.
- Privacy deletion removes messages before conversations, cascades feedback, redacts retained support cases, and removes attachment directories.

---

## 🧪 Verification & Testing

### Magento Unit Tests:
```bash
vendor/bin/phpunit app/code/Afd/AI/Test/Unit
find app/code/Afd/AI -name '*.php' -print0 | xargs -0 -n1 php -l
```

### Node.js Gateway Test Suite:
```bash
cd ai-chat-server
npm test
npm audit --omit=dev
npm run test:integration
```

---

## 🤝 Contributing

Contributions are welcome! Please check out [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on code style, testing, and pull requests.

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.
