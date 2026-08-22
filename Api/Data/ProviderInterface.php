<?php
declare(strict_types=1);

namespace Afd\AI\Api\Data;

interface ProviderInterface
{
    public const PROVIDER_ID = "provider_id";
    public const NAME = "name";
    public const PROVIDER_CODE = "provider_code";
    public const BASE_URL = "base_url";
    public const API_KEY = "api_key";
    public const API_FORMAT = "api_format";
    public const MODELS_JSON = "models_json";
    public const IS_ACTIVE = "is_active";
    public const CREATED_AT = "created_at";
    public const UPDATED_AT = "updated_at";

    public const FORMAT_ANTHROPIC_MESSAGES = "anthropic-messages";
    public const FORMAT_OPENAI_CHAT_COMPLETIONS = "openai-chat-completions";
    public const FORMAT_OPENAI_RESPONSES = "openai-responses";

    public function getProviderId(): ?int;
    public function setProviderId(int $providerId): self;

    public function getName(): ?string;
    public function setName(string $name): self;

    public function getProviderCode(): ?string;
    public function setProviderCode(string $providerCode): self;

    public function getBaseUrl(): ?string;
    public function setBaseUrl(string $baseUrl): self;

    public function getApiKey(): ?string;
    public function setApiKey(?string $apiKey): self;

    public function getApiFormat(): ?string;
    public function setApiFormat(string $apiFormat): self;

    public function getModelsJson(): ?string;
    public function setModelsJson(?string $modelsJson): self;

    /**
     * @return array<int, array<string, mixed>>
     */
    public function getModelsList(): array;

    /**
     * @param array<int, array<string, mixed>> $models
     */
    public function setModelsList(array $models): self;

    public function getIsActive(): bool;
    public function setIsActive(bool $isActive): self;

    public function getCreatedAt(): ?string;
    public function getUpdatedAt(): ?string;
}
