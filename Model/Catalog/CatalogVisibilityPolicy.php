<?php
declare(strict_types=1);

namespace Afd\AI\Model\Catalog;

use Afd\AI\Api\CatalogVisibilityPolicyInterface;
use Magento\Catalog\Model\Product\Attribute\Source\Status;
use Magento\Catalog\Model\Product\Visibility;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Module\Manager as ModuleManager;
use Magento\Store\Model\ScopeInterface;

/**
 * Canonical catalogue read policy for the AI Web API.
 *
 * Magento Web API calls have no storefront customer session.  Therefore this
 * policy always uses the verified ShopperScope rather than allowing a frontend
 * plugin to derive a group from an empty/guest request.  Aheadworks support is
 * optional and table/config based so Afd_AI remains installable without that
 * extension (and without any companion Magento module).
 */
class CatalogVisibilityPolicy implements CatalogVisibilityPolicyInterface
{
    private const AHEADWORKS_MODULE = 'Aheadworks_CustGroupCatPermissions';
    private const AHEADWORKS_PRODUCT_TABLE = 'aw_cp_product_permissions';
    private const AHEADWORKS_CATEGORY_TABLE = 'aw_cp_category_permissions';
    private const AHEADWORKS_ENABLED = 'aw_cat_permissions/general/enable';
    private const AHEADWORKS_BROWSING_MODE = 'aw_cat_permissions/catalog_permissions/browsing';
    private const AHEADWORKS_BROWSING_GROUPS = 'aw_cat_permissions/catalog_permissions/browsing_customer_groups';
    private const SHOW = 1;
    private const HIDE = 2;

    /** @var int[] */
    private const CATALOG_VISIBILITY = [
        Visibility::VISIBILITY_IN_CATALOG,
        Visibility::VISIBILITY_IN_SEARCH,
        Visibility::VISIBILITY_BOTH,
    ];

    public function __construct(
        private readonly ModuleManager $moduleManager,
        private readonly ResourceConnection $resourceConnection,
        private readonly ScopeConfigInterface $scopeConfig
    ) {
    }

    /** @inheritdoc */
    public function applyToProductCollection(
        mixed $collection,
        ShopperScope $shopperScope,
        bool $requireCatalogVisibility = true,
        bool $requireEnabled = true
    ): void {
        $collection->setStoreId($shopperScope->getStoreId());
        $collection->addStoreFilter($shopperScope->getStoreId());
        $collection->addWebsiteFilter([$shopperScope->getWebsiteId()]);
        if ($requireEnabled) {
            $collection->addAttributeToFilter('status', ['eq' => Status::STATUS_ENABLED]);
        }
        if ($requireCatalogVisibility) {
            // Fulltext collections rebuild their selected entity IDs after
            // addSearchFilter(). In that collection type Magento's
            // setVisibility() alone does not materialize a SQL predicate, so
            // a `Not Visible Individually` simple can enter the tool payload
            // while the card renderer correctly omits it. Keep the native
            // API call and add the equivalent EAV constraint explicitly so
            // the search total, payload and rendered card grid share the
            // exact same customer-visible product set.
            $collection->setVisibility(self::CATALOG_VISIBILITY);
            $collection->addAttributeToFilter('visibility', ['in' => self::CATALOG_VISIBILITY]);
        }
        $collection->addPriceData(
            $shopperScope->getCustomerGroupId(),
            $shopperScope->getWebsiteId()
        );

        $this->applyAheadworksProductPermission($collection, $shopperScope);
    }

    /** @inheritdoc */
    public function applyToCategoryCollection(mixed $collection, ShopperScope $shopperScope): void
    {
        $collection->setStoreId($shopperScope->getStoreId());
        $this->applyAheadworksCategoryPermission($collection, $shopperScope);
    }

    /** @param mixed $collection */
    private function applyAheadworksProductPermission(mixed $collection, ShopperScope $shopperScope): void
    {
        if (!$this->aheadworksEnabled() || !$this->tableExists(self::AHEADWORKS_PRODUCT_TABLE)) {
            return;
        }

        [$condition, $select] = $this->aheadworksFilter(
            self::AHEADWORKS_PRODUCT_TABLE,
            'product_id',
            $shopperScope
        );
        $collection->addFieldToFilter('entity_id', [$condition => $select]);
        // The extension's frontend plugin must not reapply a guest session to
        // this trusted service-to-service collection.
        $collection->setFlag('permission_applied', true);
    }

    /** @param mixed $collection */
    private function applyAheadworksCategoryPermission(mixed $collection, ShopperScope $shopperScope): void
    {
        if (!$this->aheadworksEnabled() || !$this->tableExists(self::AHEADWORKS_CATEGORY_TABLE)) {
            return;
        }

        [$condition, $select] = $this->aheadworksFilter(
            self::AHEADWORKS_CATEGORY_TABLE,
            'category_id',
            $shopperScope
        );
        $collection->addFieldToFilter('entity_id', [$condition => $select]);
    }

    /**
     * Reproduces Aheadworks' documented collection rule using the verified
     * store/group dimensions. In a default-show store, explicit HIDE rows are
     * excluded; in a default-hide store, only explicit SHOW rows are included.
     *
     * @return array{0:string,1:mixed}
     */
    private function aheadworksFilter(string $table, string $entityColumn, ShopperScope $shopperScope): array
    {
        $connection = $this->resourceConnection->getConnection();
        $tableName = $this->resourceConnection->getTableName($table);
        $defaultViewMode = $this->defaultAheadworksViewMode($shopperScope);
        $expectedExplicitMode = $defaultViewMode === self::SHOW ? self::HIDE : self::SHOW;
        $condition = $defaultViewMode === self::SHOW ? 'nin' : 'in';
        $select = $connection->select()
            ->from($tableName, [$entityColumn])
            ->where('(customer_group_id = ? OR customer_group_id IS NULL)', $shopperScope->getCustomerGroupId())
            ->where('(store_id = ? OR store_id IS NULL)', $shopperScope->getStoreId())
            ->where('view_mode = ?', $expectedExplicitMode);

        return [$condition, $select];
    }

    private function defaultAheadworksViewMode(ShopperScope $shopperScope): int
    {
        $storeId = $shopperScope->getStoreId();
        $mode = (string)$this->scopeConfig->getValue(
            self::AHEADWORKS_BROWSING_MODE,
            ScopeInterface::SCOPE_STORE,
            $storeId
        );
        $groups = array_values(array_filter(array_map(
            'intval',
            explode(',', (string)$this->scopeConfig->getValue(
                self::AHEADWORKS_BROWSING_GROUPS,
                ScopeInterface::SCOPE_STORE,
                $storeId
            ))
        )));

        return $mode === 'hide_from_everyone'
            || ($mode === 'hide_from_specified_customer_groups'
                && in_array($shopperScope->getCustomerGroupId(), $groups, true))
            ? self::HIDE
            : self::SHOW;
    }

    private function aheadworksEnabled(): bool
    {
        return $this->moduleManager->isEnabled(self::AHEADWORKS_MODULE)
            && $this->scopeConfig->isSetFlag(self::AHEADWORKS_ENABLED);
    }

    private function tableExists(string $table): bool
    {
        try {
            return $this->resourceConnection->getConnection()->isTableExists(
                $this->resourceConnection->getTableName($table)
            );
        } catch (\Throwable) {
            return false;
        }
    }
}
