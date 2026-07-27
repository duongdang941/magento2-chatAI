<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\System\Config;

use Afd\AI\Model\Config\Config as AiConfig;
use Magento\Backend\Block\Template\Context;
use Magento\Config\Block\System\Config\Form\Field;
use Magento\Framework\Data\Form\Element\AbstractElement;
use Magento\Framework\Escaper;
use Magento\Framework\Serialize\Serializer\Json;

class NodeSyncStatus extends Field
{
    private AiConfig $aiConfig;
    private Json $json;
    private Escaper $escaper;

    public function __construct(
        Context $context,
        AiConfig $aiConfig,
        Json $json,
        Escaper $escaper,
        array $data = []
    ) {
        parent::__construct($context, $data);
        $this->aiConfig = $aiConfig;
        $this->json = $json;
        $this->escaper = $escaper;
    }

    protected function _getElementHtml(AbstractElement $element): string
    {
        $rawStatus = $this->aiConfig->getNodeSyncStatus();
        if ($rawStatus === '') {
            return '<span class="notice">No synchronization has been attempted yet.</span>';
        }

        try {
            $status = $this->json->unserialize($rawStatus);
        } catch (\InvalidArgumentException $exception) {
            return '<span class="error">The saved synchronization status is invalid.</span>';
        }

        if (!is_array($status)) {
            return '<span class="error">The saved synchronization status is invalid.</span>';
        }

        $state = (string)($status['state'] ?? 'unknown');
        $class = $state === 'success' ? 'notice' : 'error';
        $parts = [
            sprintf('%s: %s', ucfirst($state), (string)($status['message'] ?? 'Unknown result.')),
            isset($status['synced_at']) ? 'At: ' . $status['synced_at'] : '',
            !empty($status['provider']) ? 'Provider: ' . $status['provider'] : '',
            !empty($status['model']) ? 'Model: ' . $status['model'] : '',
            !empty($status['http_status']) ? 'HTTP: ' . $status['http_status'] : '',
        ];

        return sprintf(
            '<span class="%s">%s</span>',
            $class,
            $this->escaper->escapeHtml(implode(' | ', array_filter($parts)))
        );
    }
}
