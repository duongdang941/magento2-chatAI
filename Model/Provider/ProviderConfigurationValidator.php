<?php
declare(strict_types=1);

namespace Afd\AI\Model\Provider;

use Afd\AI\Api\Data\ProviderInterface;
use Magento\Framework\Exception\LocalizedException;

/** Central validation boundary for every persisted model provider. */
class ProviderConfigurationValidator
{
    private const MAX_MODELS = 100;
    private const MAX_MODELS_JSON_BYTES = 262144;
    private const API_FORMATS = [
        ProviderInterface::FORMAT_ANTHROPIC_MESSAGES,
        ProviderInterface::FORMAT_OPENAI_CHAT_COMPLETIONS,
        ProviderInterface::FORMAT_OPENAI_RESPONSES,
    ];
    private const IMAGE_TRANSPORTS = [
        '',
        'openai-images',
        'openai-responses',
        'gemini-generate-content',
    ];
    private const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];
    private const CAPABILITY_KEYS = ['image_generation', 'video_generation', 'voice_dictation'];

    /** @throws LocalizedException */
    public function validate(ProviderInterface $provider): void
    {
        $name = trim((string)$provider->getName());
        if ($name === '' || mb_strlen($name) > 255) {
            throw new LocalizedException(__('Provider name is required and must not exceed 255 characters.'));
        }

        $code = trim((string)$provider->getProviderCode());
        if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/', $code)) {
            throw new LocalizedException(
                __('Provider code must use 1–64 lowercase letters, numbers, underscores, or hyphens.')
            );
        }

        $this->validateBaseUrl((string)$provider->getBaseUrl());

        if (!in_array((string)$provider->getApiFormat(), self::API_FORMATS, true)) {
            throw new LocalizedException(__('Unsupported provider API format.'));
        }

        $this->validateModels($provider->getModelsList());
    }

    /**
     * Validate only the network endpoint. Health probes must remain useful for
     * legacy providers whose model metadata has not been completed yet.
     *
     * @throws LocalizedException
     */
    public function validateEndpoint(string $baseUrl): void
    {
        $this->validateBaseUrl($baseUrl);
    }

    /** @throws LocalizedException */
    private function validateBaseUrl(string $baseUrl): void
    {
        $value = trim($baseUrl);
        $parts = parse_url($value);
        if ($value === '' || strlen($value) > 255 || !is_array($parts)) {
            throw new LocalizedException(__('Provider Base URL is invalid or too long.'));
        }

        $scheme = strtolower((string)($parts['scheme'] ?? ''));
        $host = trim((string)($parts['host'] ?? ''));
        if (!in_array($scheme, ['http', 'https'], true) || $host === '') {
            throw new LocalizedException(__('Provider Base URL must be an HTTP or HTTPS URL with a host.'));
        }
        if (isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment']) || isset($parts['query'])) {
            throw new LocalizedException(__('Provider Base URL must not contain credentials, a query, or a fragment.'));
        }

        $loopback = in_array(strtolower($host), ['localhost', '127.0.0.1', '::1'], true);
        if ($scheme !== 'https' && !$loopback) {
            throw new LocalizedException(__('Remote provider endpoints must use HTTPS.'));
        }

        $literalIp = trim($host, '[]');
        if (!$loopback
            && filter_var($literalIp, FILTER_VALIDATE_IP) !== false
            && filter_var(
                $literalIp,
                FILTER_VALIDATE_IP,
                FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
            ) === false
        ) {
            throw new LocalizedException(__('Private or reserved provider IP addresses are not allowed.'));
        }
    }

    /**
     * @param array<int, mixed> $models
     * @throws LocalizedException
     */
    private function validateModels(array $models): void
    {
        if (count($models) > self::MAX_MODELS) {
            throw new LocalizedException(__('A provider may define at most %1 models.', self::MAX_MODELS));
        }

        $encoded = json_encode($models, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($encoded) || strlen($encoded) > self::MAX_MODELS_JSON_BYTES) {
            throw new LocalizedException(__('The provider model configuration is too large.'));
        }

        $seen = [];
        foreach ($models as $model) {
            if (!is_array($model)) {
                throw new LocalizedException(__('Every provider model must be a structured configuration.'));
            }
            $id = trim((string)($model['id'] ?? ''));
            if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._:\/@+\-]{0,254}$/', $id)) {
                throw new LocalizedException(__('Model ID "%1" is invalid.', mb_substr($id, 0, 255)));
            }
            if (isset($seen[$id])) {
                throw new LocalizedException(__('Model ID "%1" is duplicated.', $id));
            }
            $seen[$id] = true;

            $name = trim((string)($model['name'] ?? $id));
            if ($name === '' || mb_strlen($name) > 255) {
                throw new LocalizedException(__('Model name must not exceed 255 characters.'));
            }
            $contextWindow = (int)($model['context_window'] ?? 0);
            if ($contextWindow < 1000 || $contextWindow > 10000000) {
                throw new LocalizedException(__('Model context window must be between 1,000 and 10,000,000 tokens.'));
            }

            $rawMaxOutputTokens = $model['max_output_tokens'] ?? null;
            $maxOutputConfigured = array_key_exists('max_output_tokens_configured', $model)
                ? (bool)$model['max_output_tokens_configured']
                : (is_scalar($rawMaxOutputTokens)
                    && $rawMaxOutputTokens !== null
                    && $rawMaxOutputTokens !== ''
                    && (int)$rawMaxOutputTokens !== 8192);
            if ($maxOutputConfigured) {
                if (!is_scalar($rawMaxOutputTokens) || trim((string)$rawMaxOutputTokens) === '') {
                    throw new LocalizedException(__('Model maximum output must be a number or left empty.'));
                }
                $maxOutputTokens = (int)$rawMaxOutputTokens;
                if ($maxOutputTokens < 256 || $maxOutputTokens > 1000000) {
                    throw new LocalizedException(__('Model maximum output must be between 256 and 1,000,000 tokens.'));
                }
            }

            $this->validateCapabilities($model, $id);

            $transport = trim((string)($model['image_transport'] ?? ''));
            if (!in_array($transport, self::IMAGE_TRANSPORTS, true)) {
                throw new LocalizedException(__('Model "%1" has an unsupported image API.', $id));
            }

            $reasoningLevels = $model['reasoning_levels'] ?? [];
            if (!is_array($reasoningLevels)
                || count(array_filter($reasoningLevels, 'is_string')) !== count($reasoningLevels)
                || count(array_unique($reasoningLevels)) !== count($reasoningLevels)
                || array_diff($reasoningLevels, self::REASONING_LEVELS) !== []
            ) {
                throw new LocalizedException(__('Model "%1" has invalid reasoning levels.', $id));
            }
            $reasoningDefault = trim((string)($model['reasoning_default_level'] ?? ''));
            if ($reasoningDefault !== '' && !in_array($reasoningDefault, $reasoningLevels, true)) {
                throw new LocalizedException(__('Model "%1" has an invalid default reasoning level.', $id));
            }

            $imageModel = trim((string)($model['image_model'] ?? ''));
            if ($imageModel !== '' && !preg_match('/^[A-Za-z0-9][A-Za-z0-9._:\/@+\-]{0,254}$/', $imageModel)) {
                throw new LocalizedException(__('Model "%1" has an invalid image model ID.', $id));
            }

            $voiceModel = trim((string)($model['voice_model'] ?? ''));
            if ($voiceModel !== '' && !preg_match('/^[A-Za-z0-9][A-Za-z0-9._:\/@+\-]{0,254}$/', $voiceModel)) {
                throw new LocalizedException(__('Model "%1" has an invalid voice model ID.', $id));
            }
        }
    }

    /** @param array<string, mixed> $model */
    private function validateCapabilities(array $model, string $modelId): void
    {
        if (!array_key_exists('capabilities', $model)) {
            return;
        }

        $capabilities = $model['capabilities'];
        if (!is_array($capabilities)) {
            throw new LocalizedException(__('Model "%1" has invalid capabilities.', $modelId));
        }

        foreach ($capabilities as $name => $value) {
            if (!in_array((string)$name, self::CAPABILITY_KEYS, true)
                || !is_bool($value)) {
                throw new LocalizedException(__('Model "%1" has invalid capabilities.', $modelId));
            }
        }
    }
}
