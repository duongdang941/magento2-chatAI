<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Provider;

use Afd\AI\Api\ProviderRepositoryInterface;
use Afd\AI\Model\ProviderFactory;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Cache\Manager as CacheManager;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\Result\JsonFactory;
use Magento\Framework\Event\ManagerInterface as EventManager;
use Magento\Framework\Exception\LocalizedException;
use Psr\Log\LoggerInterface;

class Save extends Action implements HttpPostActionInterface
{
    public const ADMIN_RESOURCE = "Afd_AI::providers";

    public function __construct(
        Context $context,
        private readonly ProviderRepositoryInterface $providerRepository,
        private readonly ProviderFactory $providerFactory,
        private readonly JsonFactory $jsonFactory,
        private readonly EventManager $eventManager,
        private readonly CacheManager $cacheManager,
        private readonly LoggerInterface $logger
    ) {
        parent::__construct($context);
    }

    public function execute()
    {
        $result = $this->jsonFactory->create();
        $request = $this->getRequest();

        $providerId = (int)$request->getParam("provider_id");
        $name = trim((string)$request->getParam("name"));
        $providerCode = trim((string)$request->getParam("provider_code"));
        $baseUrl = trim((string)$request->getParam("base_url"));
        $apiKey = (string)$request->getParam("api_key");
        $apiFormat = trim((string)$request->getParam("api_format"));
        $modelsData = $request->getParam("models");
        $isActive = (bool)$request->getParam("is_active", 1);

        if ($name === "" || $baseUrl === "") {
            return $result->setHttpResponseCode(400)->setData([
                "success" => false,
                "message" => __("Provider Name and Base URL are required.")
            ]);
        }

        // Parse models
        $models = [];
        if (is_array($modelsData)) {
            foreach ($modelsData as $m) {
                if (!is_array($m)) continue;
                $mId = trim((string)($m["id"] ?? ""));
                if ($mId === "") continue;
                $rawMaxOutputTokens = $m['max_output_tokens'] ?? null;
                $hasMaxOutputTokens = $this->isConfiguredOptionalNumber($rawMaxOutputTokens);
                $maxOutputConfigured = array_key_exists('max_output_tokens_configured', $m)
                    ? !empty($m['max_output_tokens_configured'])
                    : ($hasMaxOutputTokens && (int)$rawMaxOutputTokens !== 8192);
                $capabilities = $this->normalizeCapabilities($m);
                $model = [
                    "id" => $mId,
                    "name" => trim((string)($m["name"] ?? $mId)),
                    "context_window" => max(1000, (int)($m["context_window"] ?? 128000)),
                    "max_output_tokens_configured" => $maxOutputConfigured,
                    "capabilities" => $capabilities,
                    "reasoning_enabled" => !empty($m["reasoning_enabled"]),
                    "reasoning_levels" => $this->normalizeReasoningLevels($m["reasoning_levels"] ?? []),
                    "reasoning_default_level" => $this->normalizeReasoningDefaultLevel(
                        $m["reasoning_default_level"] ?? '',
                        $this->normalizeReasoningLevels($m["reasoning_levels"] ?? [])
                    ),
                    // Retain these normalized aliases for a rolling upgrade,
                    // while `capabilities` is now the source of truth.
                    "supports_images" => $capabilities['image_generation'],
                    "image_transport" => $capabilities['image_generation']
                        ? $this->normalizeImageTransport($m["image_transport"] ?? '')
                        : '',
                    "image_model" => $capabilities['image_generation']
                        ? trim((string)($m["image_model"] ?? ''))
                        : '',
                    "voice_model" => $capabilities['voice_dictation']
                        ? trim((string)($m["voice_model"] ?? ''))
                        : ''
                ];
                if ($maxOutputConfigured && $hasMaxOutputTokens) {
                    $model['max_output_tokens'] = max(256, (int)$rawMaxOutputTokens);
                }
                $models[] = $model;
            }
        }

        try {
            if ($providerId > 0) {
                $provider = $this->providerRepository->getById($providerId);
                // This identifier is referenced by store-view configuration
                // and synchronized gateway snapshots. It is immutable after
                // creation; the display name remains editable.
                $providerCode = (string)$provider->getProviderCode();
            } else {
                $provider = $this->providerFactory->create();
                if ($providerCode === '') {
                    $providerCode = preg_replace("/[^a-z0-9_-]+/i", "-", strtolower($name));
                    $providerCode = trim($providerCode, "-") ?: "provider-" . time();
                }
            }

            $provider->setName($name);
            $provider->setProviderCode($providerCode);
            $provider->setBaseUrl($baseUrl);
            if ($apiKey !== "") {
                $provider->setApiKey($apiKey);
            }
            $provider->setApiFormat($apiFormat);
            $provider->setModelsList($models);
            $provider->setIsActive($isActive);

            $this->providerRepository->save($provider);

            // Capability flags are embedded in the public chat markup.
            // Provider saves bypass Magento's normal system-config cache
            // invalidation, so remove cached pages before reporting success.
            $this->cacheManager->clean(['full_page', 'block_html']);

            // Dispatch event so SyncNodeConfig observer triggers node sync
            $this->eventManager->dispatch("admin_system_config_changed_section_afd_ai");

            return $result->setData([
                "success" => true,
                "message" => __("AI Provider %1 saved successfully.", $name),
                "provider" => [
                    "provider_id" => $provider->getProviderId(),
                    "name" => $provider->getName(),
                    "provider_code" => $provider->getProviderCode(),
                    "base_url" => $provider->getBaseUrl(),
                    "api_format" => $provider->getApiFormat(),
                    "models_count" => count($models),
                    "is_active" => $provider->getIsActive()
                ]
            ]);
        } catch (LocalizedException|\InvalidArgumentException $e) {
            return $result->setHttpResponseCode(400)->setData([
                "success" => false,
                "message" => $e->getMessage()
            ]);
        } catch (\Throwable $e) {
            $this->logger->error('Could not save AI provider.', ['exception' => $e]);
            return $result->setHttpResponseCode(500)->setData([
                "success" => false,
                "message" => __("The provider could not be saved. Check the server log and try again.")
            ]);
        }
    }

    /** @return array<int, string> */
    private function normalizeReasoningLevels(mixed $levels): array
    {
        if (!is_array($levels)) {
            return [];
        }
        $allowed = ['low', 'medium', 'high', 'xhigh'];
        $result = [];
        foreach ($levels as $level) {
            $value = strtolower(trim((string)$level));
            if (in_array($value, $allowed, true) && !in_array($value, $result, true)) {
                $result[] = $value;
            }
        }
        return $result;
    }

    private function normalizeReasoningDefaultLevel(mixed $level, array $available): string
    {
        $value = strtolower(trim((string)$level));
        return in_array($value, $available, true) ? $value : ($available[0] ?? '');
    }

    private function normalizeImageTransport(mixed $transport): string
    {
        $value = strtolower(trim((string)$transport));
        $allowed = ['openai-images', 'openai-responses', 'gemini-generate-content'];

        return in_array($value, $allowed, true) ? $value : '';
    }

    /**
     * @param array<string, mixed> $model
     * @return array{image_generation: bool, video_generation: bool, voice_dictation: bool}
     */
    private function normalizeCapabilities(array $model): array
    {
        $source = is_array($model['capabilities'] ?? null) ? $model['capabilities'] : [];
        $legacyImage = $model['supports_images'] ?? $model['supportsImages'] ?? null;
        $legacyImageEnabled = $this->normalizeCapabilityFlag($legacyImage, false);

        return [
            // Legacy supports_images was a global switch, not an explicit
            // per-model opt-out. New capability metadata is authoritative.
            'image_generation' => $this->normalizeCapabilityFlag(
                $source['image_generation'] ?? $source['create_edit_image'] ?? ($legacyImageEnabled ? true : null),
                true
            ),
            'video_generation' => $this->normalizeCapabilityFlag(
                $source['video_generation'] ?? $source['create_edit_video'] ?? null,
                false
            ),
            'voice_dictation' => $this->normalizeCapabilityFlag(
                $source['voice_dictation'] ?? $source['voice'] ?? null,
                false
            ),
        ];
    }

    private function normalizeCapabilityFlag(mixed $value, bool $fallback): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value) || is_float($value)) {
            return (int)$value === 1;
        }
        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
                return true;
            }
            if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) {
                return false;
            }
        }
        return $fallback;
    }

    private function isConfiguredOptionalNumber(mixed $value): bool
    {
        return is_int($value)
            || is_float($value)
            || (is_string($value) && trim($value) !== '');
    }
}
