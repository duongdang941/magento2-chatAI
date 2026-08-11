<?php

declare(strict_types=1);

namespace Afd\AI\Model\Config\Source;

use Magento\Framework\Data\OptionSourceInterface;

class ImageQuality implements OptionSourceInterface
{
    public function toOptionArray(): array
    {
        return [
            ['value' => 'low', 'label' => __('Low (fastest)')],
            ['value' => 'medium', 'label' => __('Medium (recommended)')],
            ['value' => 'high', 'label' => __('High (most detail)')],
        ];
    }
}
