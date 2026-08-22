<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\System\Config;

use Afd\AI\Model\ResourceModel\Provider\CollectionFactory;
use Magento\Backend\Block\Template\Context;
use Magento\Config\Block\System\Config\Form\Field;
use Magento\Framework\Data\Form\Element\AbstractElement;
use Magento\Framework\Serialize\Serializer\Json;

class ModelSelect extends Field
{
    public function __construct(
        Context $context,
        private readonly CollectionFactory $collectionFactory,
        private readonly Json $jsonSerializer,
        array $data = []
    ) {
        parent::__construct($context, $data);
    }

    protected function _getElementHtml(AbstractElement $element): string
    {
        $html = $element->getElementHtml();
        $elementId = $element->getHtmlId();

        // Build provider -> models map
        $collection = $this->collectionFactory->create();
        $collection->addFieldToFilter('is_active', 1);
        $collection->setOrder('name', 'ASC');

        $providerModelsMap = [];
        foreach ($collection as $provider) {
            $code = (string)$provider->getProviderCode();
            $models = $provider->getModelsList();
            $providerModelsMap[$code] = [];
            foreach ($models as $m) {
                $mId = (string)($m['id'] ?? '');
                if ($mId !== '') {
                    $providerModelsMap[$code][] = [
                        'value' => $mId,
                        'label' => $mId
                    ];
                }
            }
        }

        $jsonMap = $this->jsonSerializer->serialize($providerModelsMap);
        $currentVal = (string)$element->getValue();

        $script = <<<HTML
<script type="text/javascript">
require(['jquery', 'domReady!'], function($) {
    var providerModelsMap = {$jsonMap};
    var \$modelSelect = $('#{$elementId}');
    var currentSavedModel = '{$currentVal}';

    function updateModelsForProvider(providerCode) {
        if (!\$modelSelect.length) return;

        var availableModels = providerModelsMap[providerCode] || [];
        var existingVal = \$modelSelect.val() || currentSavedModel;

        \$modelSelect.empty();

        if (availableModels.length === 0) {
            \$modelSelect.append($('<option>', {
                value: '',
                text: '-- No Models Available for this Provider --'
            }));
            return;
        }

        var matched = false;
        $.each(availableModels, function(i, item) {
            var \$opt = $('<option>', {
                value: item.value,
                text: item.label
            });
            if (item.value === existingVal) {
                \$opt.prop('selected', true);
                matched = true;
            }
            \$modelSelect.append(\$opt);
        });

        if (!matched && availableModels.length > 0) {
            \$modelSelect.val(availableModels[0].value);
        }
    }

    // Find provider select by ID or attribute
    var \$providerSelect = $('#afd_ai_general_provider');
    if (!\$providerSelect.length) {
        \$providerSelect = $('select[name*="[general][fields][provider][value]"]');
    }

    if (\$providerSelect.length) {
        \$providerSelect.on('change', function() {
            var selectedProvider = $(this).val();
            updateModelsForProvider(selectedProvider);
        });

        // Initialize on page load
        updateModelsForProvider(\$providerSelect.val());
    }
});
</script>
HTML;

        return $html . $script;
    }
}
