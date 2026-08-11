<?php
declare(strict_types=1);

namespace Afd\AI\Api;

/**
 * Interface for AI Configuration Service
 * @api
 */
interface ConfigInterface
{
    /**
     * Get active AI configuration
     *
     * @return \Afd\AI\Api\Data\AiConfigInterface
     */
    public function getActiveConfig();
}
