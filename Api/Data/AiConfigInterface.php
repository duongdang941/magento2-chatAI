<?php
declare(strict_types=1);

namespace Afd\AI\Api\Data;

/**
 * Interface for AI Configuration
 * @api
 */
interface AiConfigInterface
{
    const PROVIDER = 'provider';
    const MODEL = 'model';
    const API_KEY = 'api_key';
    const BASE_URL = 'base_url';

    /**
     * Get provider
     *
     * @return string
     */
    public function getProvider();

    /**
     * Set provider
     *
     * @param string $provider
     * @return $this
     */
    public function setProvider($provider);

    /**
     * Get model
     *
     * @return string
     */
    public function getModel();

    /**
     * Set model
     *
     * @param string $model
     * @return $this
     */
    public function setModel($model);

    /**
     * Get api key
     *
     * @return string
     */
    public function getApiKey();

    /**
     * Set api key
     *
     * @param string $apiKey
     * @return $this
     */
    public function setApiKey($apiKey);

    /**
     * Get OpenAI-compatible base URL
     *
     * @return string
     */
    public function getBaseUrl();

    /**
     * Set OpenAI-compatible base URL
     *
     * @param string $baseUrl
     * @return $this
     */
    public function setBaseUrl($baseUrl);
}
