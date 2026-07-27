<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\System\Config;

use Magento\Backend\Block\Template\Context;
use Magento\Config\Block\System\Config\Form\Field;
use Magento\Framework\Data\Form\Element\AbstractElement;
use Magento\Framework\Escaper;

/** Renders a copyable secret without a form name, so it is never submitted. */
class GatewaySecret extends Field
{
    public function __construct(
        Context $context,
        private readonly Escaper $escaper,
        array $data = []
    ) {
        parent::__construct($context, $data);
    }

    protected function _getElementHtml(AbstractElement $element): string
    {
        return sprintf(
            '<input id="%s" type="text" class="input-text admin__control-text" value="%s" readonly="readonly" aria-readonly="true" style="width: 430px; max-width: 100%%;" />',
            $this->escaper->escapeHtmlAttr((string)$element->getHtmlId()),
            $this->escaper->escapeHtmlAttr((string)$element->getValue())
        );
    }
}
