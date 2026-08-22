<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config\Source;

use Magento\Framework\Data\OptionSourceInterface;

/** Fallback options; the frontend field narrows them from model metadata. */
class ThoughtLevel implements OptionSourceInterface
{
    public function toOptionArray(): array
    {
        return [
            ['value' => 'low', 'label' => __('Low')],
            ['value' => 'medium', 'label' => __('Medium')],
            ['value' => 'high', 'label' => __('High')],
            ['value' => 'xhigh', 'label' => __('Extra high')],
        ];
    }
}
