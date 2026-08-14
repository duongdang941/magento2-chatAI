<?php
declare(strict_types=1);

namespace Afd\AI\Model\Knowledge;

use Magento\Cms\Model\ResourceModel\Block\CollectionFactory as BlockCollectionFactory;
use Magento\Cms\Model\ResourceModel\Page\CollectionFactory as PageCollectionFactory;
use Magento\Cms\Model\Template\FilterProvider;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\UrlInterface;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;

/** Store-view-scoped retrieval over Magento's authoritative CMS content. */
class StoreKnowledgeSearch
{
    private const MAX_RESULTS = 8;

    /**
     * Store policies are commonly asked in a language different from the
     * language used by the CMS. Expand only well-defined policy concepts so
     * retrieval stays deterministic and never manufactures policy content.
     */
    private const POLICY_TERM_GROUPS = [
        ['return', 'returns', 'refund', 'exchange', 'widerruf', 'retoure', 'rückgabe', 'rueckgabe', 'hoàn', 'trả'],
        ['shipping', 'delivery', 'shipment', 'versand', 'lieferung', 'giao', 'vận', 'chuyển'],
        ['warranty', 'guarantee', 'garantie', 'gewährleistung', 'gewaehrleistung', 'bảo', 'hành'],
        ['payment', 'pay', 'zahlung', 'bezahlung', 'thanh', 'toán'],
        ['order', 'ordering', 'bestellung', 'bestellvorgang', 'đặt', 'hàng'],
    ];

    public function __construct(
        private readonly PageCollectionFactory $pageCollectionFactory,
        private readonly BlockCollectionFactory $blockCollectionFactory,
        private readonly FilterProvider $filterProvider,
        private readonly StoreManagerInterface $storeManager,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly UrlInterface $urlBuilder,
        private readonly ResourceConnection $resource
    ) {
    }

    /** @return array<string, mixed> */
    public function search(string $query, int $limit = 5, int $customerGroupId = 0): array
    {
        if (!$this->scopeConfig->isSetFlag('afd_ai/knowledge/enabled', ScopeInterface::SCOPE_STORE)) {
            return ['status' => 'unavailable', 'reason' => 'knowledge_disabled', 'message' => __('Store knowledge search is disabled.')->render()];
        }

        $query = trim(preg_replace('/\s+/u', ' ', $query) ?: '');
        if (mb_strlen($query) < 2) {
            return ['status' => 'requires_customer_action', 'reason' => 'query_too_short', 'message' => __('What store policy or help topic should I look up?')->render()];
        }
        $query = mb_substr($query, 0, 160);
        $terms = $this->terms($query);
        $limit = max(1, min($limit, self::MAX_RESULTS));
        $storeId = (int)$this->storeManager->getStore()->getId();
        $websiteId = (int)$this->storeManager->getStore()->getWebsiteId();
        $candidates = [];

        $pages = $this->pageCollectionFactory->create()
            ->addStoreFilter($storeId)
            ->addFieldToFilter('is_active', 1)
            ->setPageSize(30);
        $this->applySearchCondition($pages->getSelect(), $pages->getConnection(), $terms);
        foreach ($pages as $page) {
            $text = $this->plainText((string)$page->getContent());
            $identifier = (string)$page->getIdentifier();
            $title = (string)$page->getTitle();
            if (!$this->isRelevant($title, $identifier, $text, $terms, false)) {
                continue;
            }
            $candidates[] = [
                'source_type' => 'cms_page',
                'source_id' => (int)$page->getId(),
                'title' => $title,
                'identifier' => $identifier,
                'url' => $this->urlBuilder->getUrl($identifier),
                'text' => $text,
                'updated_at' => (string)$page->getUpdateTime(),
                'source_version' => hash('sha256', (string)$page->getId() . '|' . (string)$page->getUpdateTime() . '|' . $text),
                'score' => $this->score($title . ' ' . $identifier, $text, $terms),
            ];
        }

        $blocks = $this->blockCollectionFactory->create()
            ->addStoreFilter($storeId)
            ->addFieldToFilter('is_active', 1)
            ->setPageSize(20);
        $this->applySearchCondition($blocks->getSelect(), $blocks->getConnection(), $terms);
        foreach ($blocks as $block) {
            $text = $this->plainText((string)$block->getContent());
            $identifier = (string)$block->getIdentifier();
            $title = (string)$block->getTitle();
            if (!$this->isRelevant($title, $identifier, $text, $terms, true)) {
                continue;
            }
            $candidates[] = [
                'source_type' => 'cms_block',
                'source_id' => (int)$block->getId(),
                'title' => $title,
                'identifier' => $identifier,
                'url' => '',
                'text' => $text,
                'updated_at' => (string)$block->getUpdateTime(),
                'source_version' => hash('sha256', (string)$block->getId() . '|' . (string)$block->getUpdateTime() . '|' . $text),
                'score' => $this->score($title . ' ' . $identifier, $text, $terms),
            ];
        }

        foreach ($this->managedDocumentCandidates($terms, $storeId, $websiteId, max(0, $customerGroupId)) as $candidate) {
            $candidates[] = $candidate;
        }

        usort($candidates, static fn (array $left, array $right): int => $right['score'] <=> $left['score']);
        $results = [];
        foreach (array_slice($candidates, 0, $limit) as $candidate) {
            unset($candidate['score']);
            $candidate['excerpt'] = $this->excerpt((string)$candidate['text'], $terms);
            unset($candidate['text']);
            $results[] = $candidate;
        }

        return [
            'status' => 'success',
            'query' => $query,
            'store_id' => $storeId,
            'count' => count($results),
            'results' => $results,
            'source_notice' => __('Information retrieved from this store\'s CMS content and approved Knowledge Base documents.')->render(),
        ];
    }

    /** @return array<int, array<string, mixed>> */
    private function managedDocumentCandidates(array $terms, int $storeId, int $websiteId, int $customerGroupId): array
    {
        try {
            $connection = $this->resource->getConnection();
            $table = $this->resource->getTableName('afd_ai_knowledge_document');
            $select = $connection->select()
                ->from($table)
                ->where('status = ?', 'published')
                ->where('(store_id = ? OR store_id = 0)', $storeId)
                ->where('(website_id = ? OR website_id = 0)', $websiteId)
                ->where('(customer_group_id IS NULL OR customer_group_id = ?)', $customerGroupId)
                ->where('(effective_at IS NULL OR effective_at <= UTC_TIMESTAMP())')
                ->where('(expires_at IS NULL OR expires_at > UTC_TIMESTAMP())')
                ->order('updated_at DESC')
                ->limit(50);
            $conditions = [];
            foreach ($terms as $term) {
                $like = '%' . $term . '%';
                $conditions[] = $connection->quoteInto('LOWER(title) LIKE ?', $like);
                $conditions[] = $connection->quoteInto('LOWER(content) LIKE ?', $like);
            }
            if ($conditions !== []) $select->where(implode(' OR ', $conditions));

            $candidates = [];
            foreach ($connection->fetchAll($select) as $document) {
                $title = (string)($document['title'] ?? '');
                $identifier = (string)($document['identifier'] ?? '');
                $text = $this->plainText((string)($document['content'] ?? ''));
                if (!$this->isRelevant($title, $identifier, $text, $terms, false)) continue;
                $candidates[] = [
                    'source_type' => 'knowledge_document',
                    'source_id' => (int)($document['entity_id'] ?? 0),
                    'title' => $title,
                    'identifier' => $identifier,
                    'url' => (string)($document['source_url'] ?? ''),
                    'text' => $text,
                    'updated_at' => (string)($document['updated_at'] ?? ''),
                    'source_version' => sprintf('%s:%d', $identifier, (int)($document['version'] ?? 1)),
                    'score' => $this->score($title . ' ' . $identifier, $text, $terms) + 3,
                ];
            }
            return $candidates;
        } catch (\Throwable) {
            // A rolling deploy can temporarily see code before the declarative
            // schema is installed. CMS retrieval remains usable in that case.
            return [];
        }
    }

    private function terms(string $query): array
    {
        $parts = preg_split('/[^\pL\pN]+/u', mb_strtolower($query)) ?: [];
        $terms = array_values(array_unique(array_filter($parts, static fn (string $term): bool => mb_strlen($term) >= 2)));
        $expanded = $terms;
        foreach (self::POLICY_TERM_GROUPS as $group) {
            if (array_intersect($terms, $group) !== []) {
                $expanded = [...$expanded, ...$group];
            }
        }

        return array_slice(array_values(array_unique($expanded ?: [mb_strtolower($query)])), 0, 32);
    }

    private function applySearchCondition(object $select, object $connection, array $terms): void
    {
        $conditions = [];
        foreach ($terms as $term) {
            // Terms contain only Unicode letters/numbers (see terms()), so
            // SQL wildcard characters cannot enter this LIKE pattern.
            $like = '%' . $term . '%';
            $conditions[] = $connection->quoteInto('LOWER(main_table.title) LIKE ?', $like);
            $conditions[] = $connection->quoteInto('LOWER(main_table.content) LIKE ?', $like);
        }
        $select->where(implode(' OR ', $conditions));
    }

    private function plainText(string $content): string
    {
        try {
            $content = $this->filterProvider->getPageFilter()->filter($content);
        } catch (\Throwable) {
            // Raw CMS text is still useful if a widget directive cannot render in this context.
        }
        $content = html_entity_decode(strip_tags($content), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return mb_substr(trim(preg_replace('/\s+/u', ' ', $content) ?: ''), 0, 12000);
    }

    private function score(string $title, string $text, array $terms): int
    {
        $title = mb_strtolower($title);
        $text = mb_strtolower($text);
        $score = 0;
        foreach ($terms as $term) {
            $score += substr_count($title, $term) * 8;
            $score += min(substr_count($text, $term), 8);
        }
        return $score;
    }

    private function isRelevant(
        string $title,
        string $identifier,
        string $text,
        array $terms,
        bool $isBlock
    ): bool {
        $identity = mb_strtolower($title . ' ' . $identifier);
        $text = mb_strtolower($text);
        $identityMatch = false;
        $contentMatches = 0;
        foreach ($terms as $term) {
            if (mb_strpos($identity, $term) !== false) {
                $identityMatch = true;
            }
            if (mb_strpos($text, $term) !== false) {
                $contentMatches++;
            }
        }
        if ($identityMatch) {
            return true;
        }
        if ($isBlock) {
            // Layout/marketing blocks often contain generic words such as
            // shipping. Only knowledge-oriented blocks may match on body text.
            if (!preg_match('/(?:faq|help|policy|shipping|delivery|return|refund|warranty|payment|legal|terms)/i', $identifier)) {
                return false;
            }
        }
        return $contentMatches >= min(2, count($terms));
    }

    private function excerpt(string $text, array $terms): string
    {
        $lower = mb_strtolower($text);
        $position = false;
        foreach ($terms as $term) {
            $candidate = mb_strpos($lower, $term);
            if ($candidate !== false && ($position === false || $candidate < $position)) {
                $position = $candidate;
            }
        }
        $start = $position === false ? 0 : max(0, $position - 140);
        $excerpt = mb_substr($text, $start, 700);
        return ($start > 0 ? '…' : '') . $excerpt . (mb_strlen($text) > $start + 700 ? '…' : '');
    }
}
