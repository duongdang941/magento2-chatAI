<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Gateway;

use Afd\AI\Model\Gateway\GatewayTlsConfigurator;
use Magento\Framework\HTTP\Client\Curl;
use PHPUnit\Framework\TestCase;

class GatewayTlsConfiguratorTest extends TestCase
{
    public function testUsesDetectedValetCaFileWithoutDisablingTlsVerification(): void
    {
        $homeDirectory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'afd-ai-home-' . bin2hex(random_bytes(4));
        $caDirectory = $homeDirectory . '/.config/valet/CA';
        self::assertTrue(mkdir($caDirectory, 0700, true));
        $caFile = $caDirectory . '/LaravelValetCASelfSigned.pem';
        file_put_contents($caFile, 'test-ca');

        try {
            $curl = $this->createMock(Curl::class);
            $curl->expects(self::once())
                ->method('setOption')
                ->with(CURLOPT_CAINFO, $caFile);

            (new GatewayTlsConfigurator($homeDirectory))->configure($curl);
        } finally {
            @unlink($caFile);
            @rmdir($caDirectory);
            @rmdir(dirname($caDirectory));
            @rmdir(dirname(dirname($caDirectory)));
            @rmdir($homeDirectory);
        }
    }

    public function testUsesSystemCaBundleWhenValetIsNotInstalled(): void
    {
        $curl = $this->createMock(Curl::class);
        $curl->expects(self::never())->method('setOption');

        (new GatewayTlsConfigurator(sys_get_temp_dir() . '/afd-ai-no-valet'))->configure($curl);
    }
}
