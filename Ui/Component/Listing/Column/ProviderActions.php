<?php
declare(strict_types=1);

namespace Afd\AI\Ui\Component\Listing\Column;

use Magento\Framework\Escaper;
use Magento\Framework\UrlInterface;
use Magento\Framework\View\Element\UiComponent\ContextInterface;
use Magento\Framework\View\Element\UiComponentFactory;
use Magento\Ui\Component\Listing\Columns\Column;

class ProviderActions extends Column
{
    public function __construct(
        ContextInterface $context,
        UiComponentFactory $uiComponentFactory,
        private readonly UrlInterface $urlBuilder,
        private readonly Escaper $escaper,
        array $components = [],
        array $data = []
    ) {
        parent::__construct($context, $uiComponentFactory, $components, $data);
    }

    public function prepareDataSource(array $dataSource): array
    {
        if (!isset($dataSource['data']['items'])) {
            return $dataSource;
        }

        foreach ($dataSource['data']['items'] as &$item) {
            if (isset($item['provider_id'])) {
                $id = (int)$item['provider_id'];
                $providerName = $this->escaper->escapeHtml((string)($item['name'] ?? ''));
                $item[$this->getData('name')] = [
                    'edit' => [
                        'href' => 'javascript:window.openZCodeProviderEditModal(' . $id . ');',
                        'label' => __('Edit')
                    ],
                    'delete' => [
                        'href' => $this->urlBuilder->getUrl('afd_ai/provider/delete', ['provider_id' => $id]),
                        'label' => __('Delete'),
                        'confirm' => [
                            'title' => __('Delete %1', $providerName),
                            'message' => __('Are you sure you want to delete %1? This cannot be undone.', $providerName)
                        ],
                        'post' => true
                    ]
                ];
            }
        }

        return $dataSource;
    }
}
