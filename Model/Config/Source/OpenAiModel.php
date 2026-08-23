<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config\Source;

class OpenAiModel implements \Magento\Framework\Data\OptionSourceInterface
{
    public function toOptionArray(): array
    {
        return [
            ['value' => 'gpt-4o', 'label' => __('GPT-4o (State-of-the-art multimodal)')],
            ['value' => 'gpt-4o-mini', 'label' => __('GPT-4o mini (Fast & Cost-efficient)')],
            ['value' => 'o1-preview', 'label' => __('o1-preview (Advanced reasoning)')],
            ['value' => 'o1-mini', 'label' => __('o1-mini (Fast reasoning)')],
            ['value' => 'gpt-4-turbo', 'label' => __('GPT-4 Turbo (Large context)')],
            ['value' => 'gpt-4', 'label' => __('GPT-4 (Classic Capable)')],
            ['value' => 'gpt-3.5-turbo', 'label' => __('GPT-3.5 Turbo (Legacy Fast)')],
        ];
    }
}
