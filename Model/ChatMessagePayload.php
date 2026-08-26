<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Model\Payload\ProductPayloadNormalizer;
use Afd\AI\Model\Payload\OrderAddressNormalizer;
use Magento\Framework\UrlInterface;
use Magento\Store\Model\StoreManagerInterface;

class ChatMessagePayload
{
    private const MAX_WORKED_FOR_MS = 86400000;

    public function __construct(
        private readonly ProductPayloadNormalizer $productNormalizer,
        private readonly OrderAddressNormalizer $addressNormalizer,
        private readonly StoreManagerInterface $storeManager
    ) {
    }

    /**
     * Build a structured assistant payload so text and product cards survive history reloads.
     *
     * @param array<int, array<string, mixed>> $parts
     */
    public function encodeAssistantParts(array $parts, array $metadata = []): string
    {
        $normalizedParts = [];

        foreach ($parts as $part) {
            $type = (string)($part['type'] ?? 'text');

            if ($type === 'products') {
                $payload = $this->productNormalizer->normalizeProductPayload($part['payload'] ?? null);
                $html = trim((string)($part['html'] ?? ''));

                if ($payload !== null || $html !== '') {
                    $normalizedPart = ['type' => 'products'];
                    if ($payload !== null) {
                        $normalizedPart['payload'] = $payload;
                    }
                    // Preserve the already rendered Magento presentation as
                    // well as the compact payload.  The payload is useful for
                    // pagination, but it cannot reproduce image URLs,
                    // native price markup, or add-to-cart forms by itself.
                    if ($html !== '') {
                        $normalizedPart['html'] = $html;
                    }
                    $normalizedParts[] = $normalizedPart;
                }
                continue;
            }

            if ($type === 'reasoning') {
                $reasoning = $this->normalizeReasoningPart($part);
                if ($reasoning !== null) {
                    $normalizedParts[] = $reasoning;
                }
                continue;
            }

            if ($type === 'image') {
                $imagePart = $this->normalizeGeneratedImagePart($part);
                if ($imagePart !== null) {
                    $normalizedParts[] = $imagePart;
                }
                continue;
            }

            // Persist only the public form deadline. Email addresses, codes,
            // verification tokens and runtime state never enter chat history.
            if ($type === 'guest_order_access') {
                $accessPart = [
                    'type' => 'guest_order_access',
                    'purpose' => ($part['purpose'] ?? '') === 'support' ? 'support' : 'order'
                ];
                $expiresAt = max(0, (int)($part['expires_at'] ?? $part['expiresAt'] ?? 0));
                if ($expiresAt > 0) {
                    $accessPart['expires_at'] = $expiresAt;
                }
                $normalizedParts[] = $accessPart;
                continue;
            }

            if ($type === 'order_address_form') {
                $addressForm = $this->addressNormalizer->normalizeOrderAddressFormPart($part);
                if ($addressForm !== null) {
                    $normalizedParts[] = $addressForm;
                }
                continue;
            }

            $raw = (string)($part['raw'] ?? $part['text'] ?? '');
            if ($raw !== '') {
                $normalizedParts[] = [
                    'type' => 'text',
                    'raw' => $raw
                ];
            }
        }

        if ($normalizedParts === []) {
            return '';
        }

        $payload = [
            'version' => 1,
            'format' => 'afd_ai_chat_message',
            'text' => $this->extractTextFromParts($normalizedParts),
            'parts' => $normalizedParts
        ];

        if (($metadata['interrupted'] ?? false) === true) {
            $payload['interrupted'] = true;
            $payload['stopped_after_seconds'] = max(0, (int)($metadata['stopped_after_seconds'] ?? 0));
        }
        $workedForMs = $this->normalizeWorkedForMs($metadata['worked_for_ms'] ?? $metadata['workedForMs'] ?? 0);
        if ($workedForMs > 0) {
            $payload['worked_for_ms'] = $workedForMs;
        }
        if (($metadata['source'] ?? '') === 'support_agent') {
            $payload['source'] = 'support_agent';
            $payload['sender_label'] = mb_substr(trim((string)($metadata['sender_label'] ?? 'Support team')), 0, 80);
            $payload['admin_id'] = max(0, (int)($metadata['admin_id'] ?? 0));
        }

        return (string)json_encode(
            $payload,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        );
    }

    /**
     * @return array{content:string,parts:array<int,array<string,mixed>>,interrupted:bool,stopped_after_seconds:int|null,worked_for_ms:int}
     */
    public function decodeStoredMessage(string $role, string $content, string $messageId = ''): array
    {
        $fallback = [
            'content' => $content,
            'parts' => [[
                'id' => $messageId !== '' ? $messageId . '-0' : '0',
                'type' => 'text',
                'raw' => $content,
                'html' => $content
            ]],
            'interrupted' => false,
            'stopped_after_seconds' => null,
            'worked_for_ms' => 0,
            'source' => '',
            'sender_label' => '',
            'admin_id' => 0
        ];

        if ($role !== 'assistant') {
            return $fallback;
        }

        $decoded = json_decode($content, true);
        if (!is_array($decoded) || !isset($decoded['parts']) || !is_array($decoded['parts'])) {
            return $fallback;
        }

        $parts = [];
        $workedForMs = $this->normalizeWorkedForMs($decoded['worked_for_ms'] ?? $decoded['workedForMs'] ?? 0);

        foreach ($decoded['parts'] as $index => $part) {
            if (!is_array($part)) {
                continue;
            }

            $type = (string)($part['type'] ?? 'text');
            $partId = $messageId !== '' ? $messageId . '-' . $index : (string)$index;

            if ($type === 'products') {
                $payload = $this->productNormalizer->normalizeProductPayload($part['payload'] ?? null);
                $storedHtml = trim((string)($part['html'] ?? ''));
                // Re-render with the current Magento scope when possible so
                // prices, salability and CSRF forms stay fresh.  If a product
                // was deleted, disabled, or is outside the current scope,
                // Magento can legitimately return an empty collection.  Keep
                // the persisted safe grid as a presentation fallback instead
                // of dropping the entire product result from history.
                $renderedHtml = $payload !== null
                    ? $this->productNormalizer->renderProductPayload($payload)
                    : '';
                $html = $renderedHtml !== '' ? $renderedHtml : $storedHtml;
                if ($html !== '') {
                    $productPart = [
                        'id' => $partId,
                        'type' => 'products',
                        'html' => $html
                    ];
                    if ($payload !== null) {
                        $productPart['payload'] = $payload;
                    }
                    $parts[] = $productPart;
                }
                continue;
            }

            if ($type === 'reasoning') {
                $reasoning = $this->normalizeReasoningPart($part);
                if ($reasoning !== null) {
                    $reasoning['id'] = $partId;
                    $parts[] = $reasoning;
                }
                continue;
            }

            if ($type === 'image') {
                $imagePart = $this->normalizeGeneratedImagePart($part);
                if ($imagePart !== null) {
                    $imagePart['id'] = $partId;
                    $parts[] = $imagePart;
                }
                continue;
            }

            // Restore the public deadline so the form cannot gain another
            // fifteen minutes on reload. Sensitive OTP data is never returned.
            if ($type === 'guest_order_access') {
                $accessPart = [
                    'id' => $partId,
                    'type' => 'guest_order_access',
                    'purpose' => ($part['purpose'] ?? '') === 'support' ? 'support' : 'order'
                ];
                $expiresAt = max(0, (int)($part['expires_at'] ?? 0));
                if ($expiresAt > 0) {
                    $accessPart['expires_at'] = $expiresAt;
                }
                $parts[] = $accessPart;
                continue;
            }

            if ($type === 'order_address_form') {
                $addressForm = $this->addressNormalizer->normalizeOrderAddressFormPart($part);
                if ($addressForm !== null) {
                    $addressForm['id'] = $partId;
                    $parts[] = $addressForm;
                }
                continue;
            }

            $raw = (string)($part['raw'] ?? $part['text'] ?? '');
            $parts[] = [
                'id' => $partId,
                'type' => 'text',
                'raw' => $raw,
                'html' => $raw
            ];
        }

        if ($parts === []) {
            // A structured assistant row with only rejected parts must not
            // fall back to displaying the serialized JSON as customer text.
            return [
                'content' => isset($decoded['text']) && is_string($decoded['text'])
                    ? $decoded['text']
                    : '',
                'parts' => [],
                'interrupted' => ($decoded['interrupted'] ?? false) === true,
                'stopped_after_seconds' => ($decoded['interrupted'] ?? false) === true
                    ? max(0, (int)($decoded['stopped_after_seconds'] ?? 0))
                    : null,
                'worked_for_ms' => $workedForMs,
                'source' => '',
                'sender_label' => '',
                'admin_id' => 0
            ];
        }

        $parts = $this->productNormalizer->mergeSequentialProductParts($parts);
        if (!$this->productNormalizer->hasProductPart($parts)) {
            $legacyProductPart = $this->productNormalizer->recoverLegacyProductGrid(
                (string)($decoded['text'] ?? $content),
                $messageId
            );
            if ($legacyProductPart !== null) {
                $parts[] = $legacyProductPart;
            }
        }

        $interrupted = ($decoded['interrupted'] ?? false) === true;

        return [
            'content' => isset($decoded['text']) && is_string($decoded['text'])
                ? $decoded['text']
                : $this->extractTextFromParts($parts),
            'parts' => $parts,
            'interrupted' => $interrupted,
            'stopped_after_seconds' => $interrupted
                ? max(0, (int)($decoded['stopped_after_seconds'] ?? 0))
                : null,
            'worked_for_ms' => $workedForMs,
            'source' => ($decoded['source'] ?? '') === 'support_agent' ? 'support_agent' : '',
            'sender_label' => ($decoded['source'] ?? '') === 'support_agent'
                ? mb_substr(trim((string)($decoded['sender_label'] ?? 'Support team')), 0, 80)
                : '',
            'admin_id' => ($decoded['source'] ?? '') === 'support_agent'
                ? max(0, (int)($decoded['admin_id'] ?? 0))
                : 0
        ];
    }

    /**
     * @param array<int, array<string, mixed>> $parts
     */
    public function extractTextFromParts(array $parts): string
    {
        $textParts = [];

        foreach ($parts as $part) {
            $type = (string)($part['type'] ?? 'text');
            if ($type !== 'text') {
                continue;
            }

            $raw = trim((string)($part['raw'] ?? $part['text'] ?? ''));
            if ($raw !== '') {
                $textParts[] = $raw;
            }
        }

        return implode("\n\n", $textParts);
    }


    /**
     * Generated images are stored as public Magento media URLs, never image
     * bytes. Keeping this validation central means every history endpoint
     * exposes the same safe structured part to the storefront.
     *
     * @param array<string, mixed> $part
     * @return array{type:string,url:string,alt:string,prompt:string,size:string,quality:string}|null
     */
    private function normalizeGeneratedImagePart(array $part): ?array
    {
        $url = trim((string)($part['url'] ?? ''));
        if (!$this->isAllowedGeneratedImageUrl($url)) {
            return null;
        }

        return [
            'type' => 'image',
            'url' => $url,
            'alt' => mb_substr(trim((string)($part['alt'] ?? 'Generated image')) ?: 'Generated image', 0, 400),
            'prompt' => mb_substr(trim((string)($part['prompt'] ?? '')), 0, 4000),
            'size' => mb_substr(trim((string)($part['size'] ?? '')), 0, 32),
            'quality' => mb_substr(trim((string)($part['quality'] ?? '')), 0, 16),
        ];
    }

    private function isAllowedGeneratedImageUrl(string $url): bool
    {
        $generatedSuffixPattern = '~^/[A-Za-z0-9._-]{1,180}(?:[?#][A-Za-z0-9._=&%\\-]{0,200})?$~';
        if (preg_match(
            '~^/media/afd-ai/generated[A-Za-z0-9._/=?#&%\\-]*$~',
            $url
        ) === 1) {
            $relativeSuffix = substr($url, strlen('/media/afd-ai/generated'));
            return preg_match($generatedSuffixPattern, $relativeSuffix) === 1;
        }

        $candidate = parse_url($url);
        if (!is_array($candidate)
            || !in_array(strtolower((string)($candidate['scheme'] ?? '')), ['http', 'https'], true)
            || isset($candidate['user'])
            || isset($candidate['pass'])
        ) {
            return false;
        }

        try {
            $mediaBase = parse_url((string)$this->storeManager->getStore()->getBaseUrl(UrlInterface::URL_TYPE_MEDIA));
        } catch (\Throwable) {
            return false;
        }
        if (!is_array($mediaBase)) {
            return false;
        }

        $candidateHost = strtolower((string)($candidate['host'] ?? ''));
        $mediaHost = strtolower((string)($mediaBase['host'] ?? ''));
        $candidatePort = (int)($candidate['port'] ?? 0);
        $mediaPort = (int)($mediaBase['port'] ?? 0);
        if ($candidateHost === '' || !hash_equals($mediaHost, $candidateHost) || $candidatePort !== $mediaPort) {
            return false;
        }

        $generatedPath = rtrim((string)($mediaBase['path'] ?? '/media/'), '/') . '/afd-ai/generated';
        $candidatePath = (string)($candidate['path'] ?? '');
        if (!str_starts_with($candidatePath, $generatedPath)) {
            return false;
        }

        $suffix = substr($candidatePath, strlen($generatedPath));
        if (isset($candidate['query'])) {
            $suffix .= '?' . $candidate['query'];
        }
        if (isset($candidate['fragment'])) {
            $suffix .= '#' . $candidate['fragment'];
        }

        return preg_match($generatedSuffixPattern, $suffix) === 1;
    }


    /**
     * Store only customer-safe progress information. The tool name, state and
     * bounded result count are enough for a Codex-style activity timeline;
     * tool arguments, raw results and provider-only metadata never leave the
     * gateway.
     *
     * @param array<string, mixed> $part
     * @return array<string, mixed>|null
     */
    private function normalizeReasoningPart(array $part): ?array
    {
        $sourceEvents = is_array($part['events'] ?? null)
            ? $part['events']
            : array_merge(
                is_array($part['steps'] ?? null) ? $part['steps'] : [],
                is_array($part['activities'] ?? null) ? $part['activities'] : []
            );
        $events = [];
        $seen = [];

        foreach (array_slice($sourceEvents, 0, 24) as $index => $event) {
            if (!is_array($event)) {
                continue;
            }
            $type = ($event['type'] ?? '') === 'activity' ? 'activity'
                : (($event['type'] ?? '') === 'step' ? 'step' : '');
            if ($type === '') {
                continue;
            }
            $id = mb_substr(trim((string)($event['id'] ?? ($type . '-' . $index))), 0, 120);
            $key = $type . ':' . $id;
            if ($id === '' || isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;

            if ($type === 'activity') {
                $tool = preg_replace('/[^A-Za-z0-9_]/', '', (string)($event['tool'] ?? '')) ?? '';
                $tool = mb_substr($tool, 0, 80);
                if ($tool === '') {
                    continue;
                }
                $normalized = [
                    'id' => $id,
                    'type' => 'activity',
                    'tool' => $tool,
                    'state' => in_array(($event['state'] ?? ''), ['running', 'completed', 'failed'], true)
                        ? (string)$event['state']
                        : 'completed',
                ];
                $resultCount = filter_var($event['result_count'] ?? null, FILTER_VALIDATE_INT);
                if ($resultCount !== false && $resultCount >= 0) {
                    $normalized['result_count'] = min(10000, $resultCount);
                }
                $label = mb_substr(
                    trim((string)(preg_replace('/\s+/', ' ', (string)($event['label'] ?? '')) ?? '')),
                    0,
                    240
                );
                if ($label !== '') {
                    $normalized['label'] = $label;
                }
                $language = trim((string)($event['language'] ?? ''));
                if (preg_match('/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/', $language) === 1) {
                    $normalized['language'] = $language;
                }
                $turnSummary = mb_substr(
                    trim((string)(preg_replace('/\s+/', ' ', (string)($event['turn_summary'] ?? '')) ?? '')),
                    0,
                    120
                );
                if (mb_strlen($turnSummary) >= 12
                    && substr_count($turnSummary, '{duration}') === 1
                    && preg_match('/[<>`]/', $turnSummary) !== 1
                    && preg_match('/(?:https?:\/\/|www\.)/i', $turnSummary) !== 1
                ) {
                    $normalized['turn_summary'] = $turnSummary;
                }
                $events[] = $normalized;
                continue;
            }

            $content = mb_substr(trim((string)($event['content'] ?? '')), 0, 1600);
            if ($content !== '') {
                $normalized = ['id' => $id, 'type' => 'step', 'content' => $content];
                if (($event['source'] ?? '') === 'provider_reasoning') {
                    $normalized['source'] = 'provider_reasoning';
                }
                $events[] = $normalized;
            }
        }

        if ($events === []) {
            return null;
        }

        $normalized = [
            'type' => 'reasoning',
            'events' => $events,
            'steps' => array_values(array_filter($events, static fn (array $event): bool => $event['type'] === 'step')),
            'activities' => array_values(array_filter($events, static fn (array $event): bool => $event['type'] === 'activity')),
        ];
        $elapsedMs = $this->normalizeWorkedForMs($part['elapsedMs'] ?? 0);
        if ($elapsedMs > 0) {
            $normalized['elapsedMs'] = $elapsedMs;
        }

        return $normalized;
    }

    private function normalizeWorkedForMs(mixed $value): int
    {
        return min(self::MAX_WORKED_FOR_MS, max(0, (int)$value));
    }


    /**
     * Preserve configurable dimensions without assuming project-specific
     * attribute codes such as colour, size, farbe or grosse.
     *
     * @return array<int, array{code: string, label: string, values: array<int, string>}>
     */

}
