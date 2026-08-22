# Contributing to Magento 2 AI Assistant & Support Gateway

Thank you for your interest in contributing to this project!

## Development Guidelines

1. **Architecture Boundaries**:
   - Keep provider protocol adapters isolated in `ai-chat-server/services/providers/`.
   - Maintain provider neutrality in `ai-chat-server/services/tools/magento-tool-executor.js`.
   - Storefront UI components use Alpine.js in `view/frontend/web/js/chat/`.

2. **Running Tests**:
   - Run Node.js gateway tests:
     ```bash
     cd ai-chat-server && npm test
     ```
   - Run PHPUnit tests:
     ```bash
     vendor/bin/phpunit app/code/Afd/AI/Test/Unit
     ```

3. **Submitting Changes**:
   - Fork the repository.
   - Create a feature branch: `git checkout -b feature/my-new-feature`.
   - Ensure all unit tests pass (265 Node.js tests + 63 PHPUnit tests).
   - Commit your changes with clear, descriptive messages.
   - Submit a Pull Request.

## Code of Conduct

Please be respectful and constructive in all discussions and pull requests.
