<?php
declare(strict_types=1);

namespace Afd\AI\Model\Gateway;

/** Creates route-bound Magento -> gateway HMAC headers. */
class InternalRequestSigner
{
    public function signature(string $secret, string $timestamp, string $method, string $path, string $body): string
    {
        return hash_hmac('sha256', implode('.', [
            $timestamp,
            strtoupper($method),
            $this->normalizePath($path),
            $body,
        ]), $secret);
    }

    private function normalizePath(string $path): string
    {
        $normalized = '/' . ltrim(trim($path), '/');
        return preg_replace('#/+#', '/', $normalized) ?: '/';
    }
}
