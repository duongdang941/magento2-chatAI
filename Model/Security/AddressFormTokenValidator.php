<?php
declare(strict_types=1);

namespace Afd\AI\Model\Security;

use Afd\AI\Model\Config\Config as AiConfig;

/** Validates the short-lived form capability issued by the trusted Node gateway. */
class AddressFormTokenValidator
{
    private const AUDIENCE = 'afd-ai-address-form';

    public function __construct(private readonly AiConfig $config)
    {
    }

    /** @return array{valid:bool,reason:string} */
    public function validateCustomerAccount(
        string $token,
        string $formId,
        int $customerId,
        string $addressType
    ): array {
        if (strlen($token) > 2048 || $formId === '' || $customerId < 1) {
            return ['valid' => false, 'reason' => 'invalid_form_token'];
        }

        $parts = explode('.', $token);
        if (count($parts) !== 2) {
            return ['valid' => false, 'reason' => 'invalid_form_token'];
        }
        [$encoded, $signature] = $parts;
        $secret = $this->config->getWebSocketTicketSecret();
        if (strlen($secret) < 32) {
            return ['valid' => false, 'reason' => 'invalid_form_token'];
        }

        $expected = $this->base64UrlEncode(hash_hmac('sha256', $encoded, $secret, true));
        if (!hash_equals($expected, $signature)) {
            return ['valid' => false, 'reason' => 'invalid_form_token'];
        }

        try {
            $payload = json_decode($this->base64UrlDecode($encoded), true, 16, JSON_THROW_ON_ERROR);
        } catch (\Throwable) {
            return ['valid' => false, 'reason' => 'invalid_form_token'];
        }
        if (!is_array($payload) || (int)($payload['exp'] ?? 0) <= (int)round(microtime(true) * 1000)) {
            return ['valid' => false, 'reason' => 'form_expired'];
        }

        $valid = ($payload['aud'] ?? '') === self::AUDIENCE
            && ($payload['fid'] ?? '') === $formId
            && ($payload['res'] ?? '') === 'customer_account'
            && ($payload['sub'] ?? '') === 'customer:' . $customerId
            && in_array($addressType, is_array($payload['types'] ?? null) ? $payload['types'] : [], true);

        return ['valid' => $valid, 'reason' => $valid ? '' : 'invalid_form_token'];
    }

    private function base64UrlDecode(string $value): string
    {
        $decoded = base64_decode(strtr($value, '-_', '+/'), true);
        if ($decoded === false) {
            throw new \RuntimeException('Invalid token encoding.');
        }
        return $decoded;
    }

    private function base64UrlEncode(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }
}
