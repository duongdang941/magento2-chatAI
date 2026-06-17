<?php

declare(strict_types=1);

namespace Afd\AI\Model\Config\Source;

use Magento\Framework\Data\OptionSourceInterface;

class ImageSize implements OptionSourceInterface
{
    public function toOptionArray(): array
    {
        return [
            ['value' => '1024x1024', 'label' => __('Square (1024 × 1024)')],
            ['value' => '1536x1024', 'label' => __('Landscape (1536 × 1024)')],
            ['value' => '1024x1536', 'label' => __('Portrait (1024 × 1536)')],
        ];
    }
}
