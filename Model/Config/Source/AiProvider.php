<?php
namespace Afd\AI\Model\Config\Source;

class AiProvider implements \Magento\Framework\Data\OptionSourceInterface
{
    public function toOptionArray()
    {
        return [
            ['value' => 'gemini', 'label' => __('Google Gemini')],
            ['value' => 'openai', 'label' => __('OpenAI (ChatGPT)')],
            ['value' => 'openrouter', 'label' => __('OpenRouter')],
            ['value' => '9router', 'label' => __('9router')],
            ['value' => 'cockpit', 'label' => __('Cockpit (local OpenAI-compatible)')]
        ];
    }
}
