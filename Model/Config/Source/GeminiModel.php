<?php
namespace Afd\AI\Model\Config\Source;

class GeminiModel implements \Magento\Framework\Data\OptionSourceInterface
{
    public function toOptionArray(): array
    {
        return [
            ['value' => 'gemini-3-flash-preview', 'label' => __('Gemini 3 Flash Preview (Verified)')],
            ['value' => 'gemini-3.1-flash-lite-preview', 'label' => __('Gemini 3.1 Flash Lite Preview')],
            ['value' => 'gemini-2.5-flash', 'label' => __('Gemini 2.5 Flash (Stable)')],
            ['value' => 'gemini-2.5-pro', 'label' => __('Gemini 2.5 Pro (Powerful)')],
            ['value' => 'gemini-2.0-flash', 'label' => __('Gemini 2.0 Flash (Fast)')],
            ['value' => 'gemini-1.5-flash', 'label' => __('Gemini 1.5 Flash (Old)')],
        ];
    }
}
