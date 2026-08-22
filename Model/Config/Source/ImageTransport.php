<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config\Source;

use Magento\Framework\Data\OptionSourceInterface;

class ImageTransport implements OptionSourceInterface
{
    public function toOptionArray(): array
    {
        return [
            ['value' => '', 'label' => __('No native Image API / use SVG fallback')],
            ['value' => 'openai-images', 'label' => __('OpenAI Images API')],
            ['value' => 'openai-responses', 'label' => __('OpenAI Responses image-generation tool')],
            ['value' => 'gemini-generate-content', 'label' => __('Gemini generateContent API')],
        ];
    }
}
