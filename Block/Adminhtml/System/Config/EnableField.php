<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\System\Config;

use Magento\Config\Block\System\Config\Form\Field;
use Magento\Framework\Data\Form\Element\AbstractElement;

class EnableField extends Field
{
    protected function _getElementHtml(AbstractElement $element): string
    {
        $html = $element->getElementHtml();
        $elementId = $element->getHtmlId();

        $script = <<<HTML
<script type="text/javascript">
require(['jquery', 'domReady!'], function($) {
    var \$enabledSelect = $('#{$elementId}');
    if (!\$enabledSelect.length) {
        \$enabledSelect = $('select[name*="[general][fields][enabled][value]"]');
    }

    var groupIds = [
        'features',
        'attachments',
        'rate_limiting',
        'capacity',
        'store_knowledge',
        'human_handoff',
        'privacy_retention',
        'magento_oauth',
        'gateway_security'
    ];

    function toggleAllDependentSections(isEnabled) {
        // Toggle all other group fieldsets and their accordion headers
        groupIds.forEach(function(gid) {
            var \$head = $('#afd_ai_' + gid + '-head');
            var \$fieldset = $('#afd_ai_' + gid);
            var \$sectionWrapper = \$head.closest('.section-config');

            if (\$sectionWrapper.length) {
                \$sectionWrapper.toggle(isEnabled);
            } else {
                \$head.parent().toggle(isEnabled);
                \$fieldset.toggle(isEnabled);
            }
        });
    }

    if (\$enabledSelect.length) {
        \$enabledSelect.on('change', function() {
            var isEnabled = String($(this).val()) === '1';
            toggleAllDependentSections(isEnabled);
        });

        // Initialize state on page load
        toggleAllDependentSections(String(\$enabledSelect.val()) === '1');
    }
});
</script>
HTML;

        return $html . $script;
    }
}
