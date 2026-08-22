<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\System\Config;

use Afd\AI\Model\ResourceModel\Provider\CollectionFactory;
use Magento\Backend\Block\Template\Context;
use Magento\Config\Block\System\Config\Form\Field;
use Magento\Framework\Data\Form\Element\AbstractElement;

class ThoughtLevelSelect extends Field
{
    private const ALLOWED_LEVELS = ['low', 'medium', 'high', 'xhigh'];

    public function __construct(
        Context $context,
        private readonly CollectionFactory $collectionFactory,
        array $data = []
    ) {
        parent::__construct($context, $data);
    }

    protected function _getElementHtml(AbstractElement $element): string
    {
        $providerModels = [];
        $collection = $this->collectionFactory->create();
        $collection->addFieldToFilter('is_active', 1);

        foreach ($collection as $provider) {
            $models = [];
            foreach ($provider->getModelsList() as $model) {
                if (!is_array($model) || empty($model['reasoning_enabled'])) {
                    continue;
                }
                $id = trim((string)($model['id'] ?? ''));
                if ($id === '') {
                    continue;
                }
                $levels = $this->normalizeLevels($model['reasoning_levels'] ?? $model['thought_levels'] ?? []);
                $models[$id] = [
                    'levels' => $levels ?: self::ALLOWED_LEVELS,
                    'default' => strtolower(trim((string)($model['reasoning_default_level'] ?? ''))),
                ];
            }
            $providerModels[(string)$provider->getProviderCode()] = $models;
        }

        $modelsJson = json_encode($providerModels, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
        $selectedJson = json_encode((string)$element->getValue(), JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
        $fieldId = json_encode($element->getHtmlId(), JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);

        return $element->getElementHtml() . <<<HTML
<script type="text/javascript">
require(['jquery', 'domReady!'], function (\$) {
    var modelMap = {$modelsJson};
    var fieldId = {$fieldId};
    var savedValue = {$selectedJson};
    var \$select = \$('#' + fieldId);
    var \$row = \$select.closest('tr');
    if (!\$row.length) {
        \$row = \$select.closest('.admin__field');
    }

    function labelFor(level) {
        return level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1);
    }

    function refresh() {
        var provider = $('#afd_ai_general_provider').val();
        var model = $('#afd_ai_general_model').val();
        var metadata = modelMap[provider] && modelMap[provider][model];
        if (!metadata || !metadata.levels || !metadata.levels.length) {
            \$select.empty();
            \$row.hide();
            return;
        }

        var selected = \$select.val() || savedValue;
        if (\$.inArray(selected, metadata.levels) === -1) {
            selected = \$.inArray(metadata.default, metadata.levels) !== -1
                ? metadata.default
                : metadata.levels[0];
        }
        \$select.empty();
        \$.each(metadata.levels, function (_, level) {
            \$select.append(\$('<option>', { value: level, text: labelFor(level) }));
        });
        \$select.val(selected);
        \$row.show();
    }

    $('#afd_ai_general_provider, #afd_ai_general_model').on('change', refresh);
    refresh();
});
</script>
HTML;
    }

    /** @return array<int, string> */
    private function normalizeLevels(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $result = [];
        foreach ($value as $level) {
            $normalized = strtolower(trim((string)$level));
            if (in_array($normalized, self::ALLOWED_LEVELS, true) && !in_array($normalized, $result, true)) {
                $result[] = $normalized;
            }
        }
        return $result;
    }
}
