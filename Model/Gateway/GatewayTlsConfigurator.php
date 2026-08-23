<?php
declare(strict_types=1);

namespace Afd\AI\Model\Gateway;

use Magento\Framework\HTTP\Client\Curl;

/**
 * Applies the local Valet CA bundle only to Magento-to-gateway requests for a
 * local Valet hostname when it is available on the current machine.
 *
 * Production has no Valet CA file, so cURL retains the operating system CA
 * bundle and validates the public gateway certificate normally. No hostname,
 * user path or local domain is stored in Magento configuration.
 */
class GatewayTlsConfigurator
{
    private const VALET_CA_RELATIVE_PATHS = [
        '.config/valet/CA/LaravelValetCASelfSigned.pem',
        '.valet/CA/LaravelValetCASelfSigned.pem',
    ];

    public function __construct(private readonly string $homeDirectory = '')
    {
    }

    public function configure(Curl $curl, string $targetUrl): void
    {
        if (!$this->usesValetCertificate($targetUrl)) {
            return;
        }

        foreach ($this->valetCaCandidates() as $caFile) {
            if (is_file($caFile) && is_readable($caFile)) {
                $curl->setOption(CURLOPT_CAINFO, $caFile);
                return;
            }
        }
    }

    private function usesValetCertificate(string $targetUrl): bool
    {
        $host = parse_url(trim($targetUrl), PHP_URL_HOST);
        if (!is_string($host)) {
            return false;
        }

        $host = strtolower(rtrim($host, '.'));
        return $host === 'localhost' || str_ends_with($host, '.test');
    }

    /** @return string[] */
    private function valetCaCandidates(): array
    {
        $home = trim($this->homeDirectory);
        if ($home === '') {
            $home = trim((string)getenv('HOME'));
        }
        if ($home === '' && function_exists('posix_getpwuid') && function_exists('posix_geteuid')) {
            $user = posix_getpwuid(posix_geteuid());
            $home = is_array($user) ? trim((string)($user['dir'] ?? '')) : '';
        }
        if ($home === '') {
            return [];
        }

        return array_map(
            static fn (string $relativePath): string => rtrim($home, DIRECTORY_SEPARATOR)
                . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath),
            self::VALET_CA_RELATIVE_PATHS
        );
    }
}
