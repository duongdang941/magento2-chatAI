<?php
declare(strict_types=1);

namespace Afd\AI\Plugin\Csp;

use Afd\AI\Model\Config\Config;
use Magento\Csp\Api\CspRendererInterface;
use Magento\Framework\App\Response\HttpInterface;

/**
 * Allow the browser to open the configured AI WebSocket endpoint.
 *
 * The endpoint may be same-origin (the production reverse-proxy setup) or a
 * separate local/gateway origin.  It is read from Magento Admin so the CSP
 * follows the deployment URL without embedding a local hostname in code.
 */
class AddChatGatewayOrigin
{
    public function __construct(private readonly Config $config)
    {
    }

    public function afterRender(
        CspRendererInterface $subject,
        mixed $result,
        HttpInterface $response
    ): mixed {
        $origin = $this->chatGatewayOrigin();
        if ($origin === '') {
            return $result;
        }

        foreach (['Content-Security-Policy', 'Content-Security-Policy-Report-Only'] as $headerName) {
            $header = $response->getHeader($headerName);
            if (!$header) {
                continue;
            }

            $value = (string)$header->getFieldValue();
            $response->setHeader($headerName, $this->appendConnectSource($value, $origin), true);
        }

        return $result;
    }

    private function chatGatewayOrigin(): string
    {
        $url = trim($this->config->getChatServerUrl());
        if ($url === '') {
            return '';
        }

        $parsed = parse_url($url);
        if (!is_array($parsed)) {
            return '';
        }

        $scheme = strtolower((string)($parsed['scheme'] ?? ''));
        if (!in_array($scheme, ['ws', 'wss'], true)) {
            return '';
        }

        $host = strtolower(trim((string)($parsed['host'] ?? '')));
        if ($host === '') {
            return '';
        }

        $port = (int)($parsed['port'] ?? 0);
        $defaultPort = ($scheme === 'ws' && $port === 80) || ($scheme === 'wss' && $port === 443);

        return $scheme . '://' . $host . ($port > 0 && !$defaultPort ? ':' . $port : '');
    }

    private function appendConnectSource(string $policy, string $origin): string
    {
        if (preg_match('/(?:^|;)\\s*connect-src\\s+([^;]*)/i', $policy, $matches)) {
            if (preg_match('/(?:^|\\s)' . preg_quote($origin, '/') . '(?:\\s|$)/i', $matches[1])) {
                return $policy;
            }

            return preg_replace_callback(
                '/((?:^|;)\\s*connect-src\\s+)([^;]*)/i',
                static fn(array $match): string => $match[1] . trim($match[2]) . ' ' . $origin,
                $policy,
                1
            ) ?: $policy;
        }

        return rtrim($policy, " ;") . '; connect-src ' . $origin . ';';
    }
}
