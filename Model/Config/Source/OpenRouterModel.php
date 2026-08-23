<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config\Source;

class OpenRouterModel implements \Magento\Framework\Data\OptionSourceInterface
{
    public function toOptionArray(): array
    {
        return [
            ['value' => 'anthropic/claude-3.5-sonnet', 'label' => __('Claude 3.5 Sonnet (Balanced)')],
            ['value' => 'anthropic/claude-3-opus', 'label' => __('Claude 3 Opus (Most Powerful)')],
            ['value' => 'anthropic/claude-3-haiku', 'label' => __('Claude 3 Haiku (Fastest)')],
            ['value' => 'meta-llama/llama-3.1-405b-instruct', 'label' => __('Llama 3.1 405B (Open State-of-the-art)')],
            ['value' => 'meta-llama/llama-3.1-70b-instruct', 'label' => __('Llama 3.1 70B (Great all-rounder)')],
            ['value' => 'meta-llama/llama-3.1-8b-instruct', 'label' => __('Llama 3.1 8B (Fast Open Model)')],
            ['value' => 'google/gemini-pro-1.5', 'label' => __('Gemini 1.5 Pro (via OpenRouter)')],
            ['value' => 'google/gemini-flash-1.5', 'label' => __('Gemini 1.5 Flash (via OpenRouter)')],
            ['value' => 'mistralai/mistral-large', 'label' => __('Mistral Large')],
            ['value' => 'perplexity/llama-3.1-sonar-large-128k-online', 'label' => __('Perplexity Sonar (Web Search)')],
        ];
    }
}
