<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config\Source;

use Magento\Framework\Data\OptionSourceInterface;

class ApiFormat implements OptionSourceInterface
{
    public function toOptionArray(): array
    {
        return [
            ['value' => 'anthropic-messages', 'label' => __('Anthropic messages (/v1/messages)')],
            ['value' => 'openai-chat-completions', 'label' => __('Chat completions (/v1/chat/completions)')],
            ['value' => 'openai-responses', 'label' => __('Responses (/responses)')]
        ];
    }
}
