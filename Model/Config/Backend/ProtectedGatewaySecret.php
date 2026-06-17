<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config\Backend;

use Afd\AI\Model\Gateway\GatewaySecretManager;
use Magento\Framework\App\Cache\TypeListInterface;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\Config\Value;
use Magento\Framework\Data\Collection\AbstractDb;
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\Model\Context;
use Magento\Framework\Model\ResourceModel\AbstractResource;
use Magento\Framework\Registry;

/**
 * Rejects changes to the gateway trust secrets made through the configuration
 * form, including direct HTTP requests which bypass the read-only UI.
 */
class ProtectedGatewaySecret extends Value
{
    public function __construct(
        Context $context,
        Registry $registry,
        ScopeConfigInterface $config,
        TypeListInterface $cacheTypeList,
        private readonly GatewaySecretManager $gatewaySecretManager,
        ?AbstractResource $resource = null,
        ?AbstractDb $resourceCollection = null,
        array $data = []
    ) {
        parent::__construct(
            $context,
            $registry,
            $config,
            $cacheTypeList,
            $resource,
            $resourceCollection,
            $data
        );
    }

    protected function _afterLoad()
    {
        parent::_afterLoad();
        $this->setValue($this->gatewaySecretManager->reveal((string)$this->getValue()));

        return $this;
    }

    public function beforeSave()
    {
        // getOldValue() comes from the persisted configuration, not the Admin
        // POST body. Therefore an empty input or a crafted request cannot
        // overwrite a functioning Magento <-> Node trust credential.
        $this->setValue($this->gatewaySecretManager->preserveOrCreate($this->getOldValue()));

        return parent::beforeSave();
    }

    /**
     * Magento removes a value when an `inherit` field is forged in the form
     * POST. A read-only input does not normally send this field, but reject
     * that deletion path as well rather than relying on the browser UI.
     */
    public function beforeDelete()
    {
        throw new LocalizedException(
            __('Gateway credentials are managed by Magento and cannot be deleted from Admin configuration.')
        );
    }
}
