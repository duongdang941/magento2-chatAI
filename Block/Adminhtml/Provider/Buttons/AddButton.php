<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\Provider\Buttons;

use Magento\Framework\View\Element\UiComponent\Control\ButtonProviderInterface;

class AddButton implements ButtonProviderInterface
{
    public function getButtonData(): array
    {
        return [
            "label" => __("Add Provider"),
            "class" => "add primary",
            "on_click" => "if (window.openZCodeProviderModal) { window.openZCodeProviderModal(); }",
            "sort_order" => 10,
        ];
    }
}
