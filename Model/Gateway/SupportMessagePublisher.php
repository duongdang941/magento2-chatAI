<?php
declare(strict_types=1);

namespace Afd\AI\Model\Gateway;

use Afd\AI\Model\Config\Config as AiConfig;
use Magento\Framework\HTTP\Client\CurlFactory;
use Magento\Framework\Serialize\Serializer\Json;
use Psr\Log\LoggerInterface;

class SupportMessagePublisher
{
    public function __construct(
        private readonly CurlFactory $curlFactory,
        private readonly AiConfig $aiConfig,
        private readonly Json $json,
        private readonly LoggerInterface $logger,
        private readonly InternalRequestSigner $requestSigner,
        private readonly GatewayTlsConfigurator $gatewayTlsConfigurator
    ) {
    }

    /** @param array<string, mixed> $case */
    public function publish(array $case, int $messageId): void
    {
        if ($messageId < 1) {
            return;
        }
        $this->post('/internal/support-message', $case, ['message_id' => $messageId], 'reply');
    }

    /** @param array<string, mixed> $case @param array<string, mixed> $mutation */
    public function publishMutation(array $case, array $mutation): void
    {
        $messageId = (int)($mutation['message_id'] ?? 0);
        $operation = (string)($mutation['operation'] ?? '');
        if ($messageId < 1 || !in_array($operation, ['edit', 'delete'], true)) {
            return;
        }
        $this->post('/internal/support-message-mutation', $case, [
            'message_id' => $messageId,
            'operation' => $operation,
            'content' => mb_substr((string)($mutation['content'] ?? ''), 0, 4000),
            'edited_at' => (string)($mutation['edited_at'] ?? ''),
            'deleted_at' => (string)($mutation['deleted_at'] ?? ''),
        ], 'mutation');
    }

    /** @param array<string, mixed> $case */
    public function publishMode(array $case, bool $active, string $agentLabel = ''): void
    {
        $this->post('/internal/support-mode', $case, [
            'active' => $active,
            'agent_label' => mb_substr(trim($agentLabel), 0, 80),
        ], 'mode');
    }

    /** @param array<string, mixed> $case @param array<string, mixed> $extra */
    private function post(string $path, array $case, array $extra, string $eventType): void
    {
        $url = $this->toHttpUrl(trim((string)$this->aiConfig->getChatServerUrl()));
        $secret = $this->aiConfig->getNodeSyncSecret();
        if ($url === '' || strlen($secret) < 32) {
            return;
        }

        $payload = [
            'version' => 1,
            'event_id' => bin2hex(random_bytes(16)),
            'conversation_id' => (int)($case['conversation_id'] ?? 0),
            'customer_id' => (int)($case['customer_id'] ?? 0),
            'guest_id' => (string)($case['guest_id'] ?? ''),
        ] + $extra;
        $body = $this->json->serialize($payload);
        $timestamp = (string)time();

        try {
            $curl = $this->curlFactory->create();
            $this->gatewayTlsConfigurator->configure($curl, $url);
            $curl->setTimeout(5);
            $curl->addHeader('Accept', 'application/json');
            $curl->addHeader('Content-Type', 'application/json');
            $curl->addHeader('X-Afd-AI-Timestamp', $timestamp);
            $curl->addHeader(
                'X-Afd-AI-Signature',
                $this->requestSigner->signature($secret, $timestamp, 'POST', $path, $body)
            );
            $curl->post(rtrim($url, '/') . $path, $body);
            if ($curl->getStatus() < 200 || $curl->getStatus() >= 300) {
                throw new \RuntimeException(sprintf('Gateway returned HTTP %d.', $curl->getStatus()));
            }
        } catch (\Throwable $exception) {
            // The durable database write is authoritative. A reconnect/history
            // reload still delivers the reply when realtime delivery fails.
            $this->logger->warning('Afd AI support realtime notification failed.', [
                'exception' => $exception,
                'event_type' => $eventType,
            ]);
        }
    }

    private function toHttpUrl(string $url): string
    {
        if (str_starts_with($url, 'wss://')) {
            return 'https://' . substr($url, 6);
        }
        if (str_starts_with($url, 'ws://')) {
            return 'http://' . substr($url, 5);
        }
        return str_starts_with($url, 'http://') || str_starts_with($url, 'https://') ? $url : '';
    }
}
