<?php
declare(strict_types=1);

namespace Afd\AI\Model\Support;

use Afd\AI\Model\Gateway\SupportMessagePublisher;
use Afd\AI\Model\Order\GuestOrderVerification;
use Afd\AI\Model\Security\ActionRateLimiter;
use Magento\Customer\Api\CustomerRepositoryInterface;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Framework\Math\Random;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;

class SupportCaseService
{
    private const CATEGORIES = ['general', 'sales', 'order', 'shipping', 'billing', 'return', 'refund', 'technical'];
    private const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly StoreManagerInterface $storeManager,
        private readonly GuestOrderVerification $emailVerification,
        private readonly ActionRateLimiter $rateLimiter,
        private readonly EncryptorInterface $encryptor,
        private readonly Random $random,
        private readonly SupportCaseNotifier $notifier,
        private readonly SupportMessagePublisher $publisher,
        private readonly CustomerRepositoryInterface $customerRepository
    ) {
    }

    /** @return array<string, mixed> */
    public function create(
        int $conversationId,
        ?int $customerId,
        ?string $guestId,
        string $category,
        string $subject,
        string $summary,
        string $priority = 'normal',
        array $context = [],
        ?int $messageId = null,
        string $guestEmail = '',
        string $verificationToken = '',
        string $verificationSessionId = ''
    ): array {
        $scope = $this->currentStoreScope();
        if (!$this->scopeConfig->isSetFlag('afd_ai/support/enabled', ScopeInterface::SCOPE_STORE, $scope['store_id'])) {
            return ['status' => 'unavailable', 'reason' => 'handoff_disabled', 'message' => __('Human support handoff is currently unavailable.')->render()];
        }
        $guestId = strtolower(trim((string)$guestId));
        $sourceConversation = $this->getOwnedSourceConversation($conversationId, $customerId, $guestId, $scope);
        if ($sourceConversation === null) {
            return ['status' => 'error', 'reason' => 'conversation_not_owned', 'message' => __('The conversation could not be verified.')->render()];
        }

        $contactEmail = $this->verifiedContactEmail(
            $customerId,
            $guestEmail,
            $verificationToken,
            $verificationSessionId
        );
        if ($contactEmail === '') {
            return $this->supportVerificationRequired((int)($customerId ?? 0));
        }

        $identity = ($customerId ?? 0) > 0 ? 'customer:' . $customerId : 'guest:' . $guestId;
        $throttle = $this->rateLimiter->consume('support_case', $identity, 3, 3600);
        if (!$throttle['allowed']) {
            return [
                'status' => 'rate_limited',
                'reason' => 'too_many_cases',
                'retry_after' => $throttle['retry_after'],
                'message' => __('A support request was recently created. Please wait before creating another one.')->render(),
            ];
        }

        $category = strtolower(trim($category));
        $category = in_array($category, self::CATEGORIES, true) ? $category : 'general';
        $priority = strtolower(trim($priority));
        $priority = in_array($priority, self::PRIORITIES, true) ? $priority : 'normal';
        $subject = mb_substr(trim(preg_replace('/\s+/u', ' ', $subject) ?: ''), 0, 255);
        $summary = mb_substr(trim($summary), 0, 4000);
        if ($subject === '' || $summary === '') {
            return ['status' => 'error', 'reason' => 'missing_summary', 'message' => __('Describe what you need help with.')->render()];
        }

        $publicId = $this->createPublicId();
        $now = gmdate('Y-m-d H:i:s');
        $connection = $this->resource->getConnection();
        $conversationTable = $this->resource->getTableName('afd_ai_conversation');
        $messageTable = $this->resource->getTableName('afd_ai_message');
        $caseTable = $this->resource->getTableName('afd_ai_support_case');
        $connection->beginTransaction();
        try {
            $connection->insert($conversationTable, [
                'customer_id' => ($customerId ?? 0) > 0 ? $customerId : null,
                'guest_id' => ($customerId ?? 0) > 0 ? null : $guestId,
                'store_id' => $scope['store_id'],
                'website_id' => $scope['website_id'],
                'title' => mb_substr($subject, 0, 255),
                'conversation_type' => 'support',
                'is_archived' => 0,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
            $ticketConversationId = (int)$connection->lastInsertId($conversationTable);
            $connection->insert($messageTable, [
                'session_id' => ($customerId ?? 0) > 0 ? 'support-customer:' . $customerId : 'support-guest:' . $guestId,
                'customer_id' => ($customerId ?? 0) > 0 ? $customerId : null,
                'conversation_id' => $ticketConversationId,
                'role' => 'user',
                'content' => $summary,
                'attachment' => null,
                'created_at' => $now,
            ]);
            $initialMessageId = (int)$connection->lastInsertId($messageTable);

            $row = [
                'public_id' => $publicId,
                'conversation_id' => $ticketConversationId,
                'source_conversation_id' => $conversationId,
                'message_id' => $initialMessageId,
                'customer_id' => ($customerId ?? 0) > 0 ? $customerId : null,
                'guest_id' => ($customerId ?? 0) > 0 ? null : $guestId,
                'store_id' => $scope['store_id'],
                'website_id' => $scope['website_id'],
                'category' => $category,
                'priority' => $priority,
                'status' => 'open',
                'subject' => $subject,
                'summary' => $summary,
                'context_json' => $this->encodeContext($context),
                'contact_email' => $contactEmail !== '' ? $this->encryptor->encrypt($contactEmail) : null,
                'contact_email_hash' => hash('sha256', $contactEmail),
                'admin_unread_count' => 1,
                'customer_unread_count' => 0,
                'last_customer_message_at' => $now,
                // Only the new ticket thread is private customer/admin chat.
                // The source AI conversation remains available to the user.
                'takeover_state' => 'active',
                'created_at' => $now,
                'updated_at' => $now,
            ];
            $connection->insert($caseTable, $row);
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }

        $safeCase = [
            'public_id' => $publicId,
            'category' => $category,
            'priority' => $priority,
            'subject' => $subject,
            'summary' => $summary,
            'conversation_id' => $ticketConversationId,
            'created_at' => $now,
            'store_id' => $scope['store_id'],
            'website_id' => $scope['website_id'],
        ];
        $this->notifier->notify($safeCase);
        $this->publisher->publishMode($row, true, (string)__('Support team'));

        return [
            'status' => 'success',
            'case' => $safeCase + ['status' => 'open'],
            'message' => __('Support request %1 was created in a separate private conversation.', $publicId)->render(),
        ];
    }

    /** @return array<string, mixed> */
    public function listVerified(
        ?int $customerId,
        ?string $guestId,
        string $email,
        string $verificationToken,
        string $verificationSessionId
    ): array {
        $contactEmail = $this->verifiedContactEmail(
            $customerId,
            $email,
            $verificationToken,
            $verificationSessionId
        );
        if ($contactEmail === '') {
            return $this->supportVerificationRequired((int)($customerId ?? 0));
        }

        $guestId = strtolower(trim((string)$guestId));
        if (($customerId ?? 0) < 1 && !preg_match('/^[a-f0-9]{64}$/', $guestId)) {
            return ['status' => 'error', 'reason' => 'invalid_identity', 'cases' => []];
        }
        $scope = $this->currentStoreScope();
        $connection = $this->resource->getConnection();
        $select = $connection->select()
            ->from(['support_case' => $this->resource->getTableName('afd_ai_support_case')])
            ->joinInner(
                ['conversation' => $this->resource->getTableName('afd_ai_conversation')],
                "conversation.conversation_id = support_case.conversation_id"
                    . " AND conversation.conversation_type = 'support'",
                []
            )
            ->where('support_case.contact_email_hash = ?', hash('sha256', $contactEmail))
            ->where('support_case.store_id = ?', $scope['store_id'])
            ->where('support_case.website_id = ?', $scope['website_id'])
            ->where('conversation.store_id = ?', $scope['store_id'])
            ->where('conversation.website_id = ?', $scope['website_id'])
            ->order('support_case.updated_at DESC')
            ->limit(20);
        $cases = $connection->fetchAll($select);

        // A fresh browser session receives a new guest ID. Successful OTP is
        // the authority for reconnecting that email's private ticket threads
        // to the current verified identity.
        foreach ($cases as &$case) {
            $ticketConversationId = (int)($case['conversation_id'] ?? 0);
            if ($ticketConversationId < 1) {
                if (!in_array((string)($case['status'] ?? ''), ['resolved', 'closed'], true)) {
                    $now = gmdate('Y-m-d H:i:s');
                    $connection->update(
                        $this->resource->getTableName('afd_ai_support_case'),
                        [
                            'status' => 'closed',
                            'takeover_state' => 'inactive',
                            'takeover_expires_at' => null,
                            'takeover_ended_at' => $now,
                            'resolved_at' => $now,
                            'updated_at' => $now,
                        ],
                        ['entity_id = ?' => (int)$case['entity_id']]
                    );
                    $case['status'] = 'closed';
                    $case['resolved_at'] = $now;
                    $case['updated_at'] = $now;
                }
                continue;
            }
            $ownerData = ($customerId ?? 0) > 0
                ? ['customer_id' => (int)$customerId, 'guest_id' => null]
                : ['customer_id' => null, 'guest_id' => $guestId];
            $connection->update(
                $this->resource->getTableName('afd_ai_conversation'),
                $ownerData,
                ['conversation_id = ?' => $ticketConversationId, 'conversation_type = ?' => 'support']
            );
            $connection->update(
                $this->resource->getTableName('afd_ai_support_case'),
                $ownerData,
                ['entity_id = ?' => (int)$case['entity_id']]
            );
            $case = array_merge($case, $ownerData);
        }
        unset($case);

        return [
            'status' => 'success',
            'cases' => array_map(fn (array $case): array => $this->safeCase($case), $cases),
        ];
    }

    /** @param array<string, mixed> $case */
    private function safeCase(array $case): array
    {
        return [
            'public_id' => (string)($case['public_id'] ?? ''),
            'category' => (string)($case['category'] ?? 'general'),
            'priority' => (string)($case['priority'] ?? 'normal'),
            'status' => (string)($case['status'] ?? 'open'),
            'subject' => (string)($case['subject'] ?? ''),
            'summary' => (string)($case['summary'] ?? ''),
            'created_at' => (string)($case['created_at'] ?? ''),
            'updated_at' => (string)($case['updated_at'] ?? ''),
            'conversation_id' => (int)($case['conversation_id'] ?? 0),
            'customer_unread_count' => (int)($case['customer_unread_count'] ?? 0),
        ];
    }

    private function resolveVerifiedContactEmail(string $email): string
    {
        $email = strtolower(trim($email));
        return filter_var($email, FILTER_VALIDATE_EMAIL) ? mb_substr($email, 0, 254) : '';
    }

    private function verifiedContactEmail(
        ?int $customerId,
        string $guestEmail,
        string $verificationToken,
        string $verificationSessionId
    ): string {
        if (($customerId ?? 0) > 0) {
            try {
                return $this->resolveVerifiedContactEmail(
                    (string)$this->customerRepository->getById((int)$customerId)->getEmail()
                );
            } catch (\Throwable) {
                return '';
            }
        }

        $contactEmail = $this->resolveVerifiedContactEmail($guestEmail);

        return $contactEmail !== '' && $this->emailVerification->hasAccess(
            trim($verificationToken),
            trim($verificationSessionId),
            $contactEmail
        ) ? $contactEmail : '';
    }

    /** @return array<string, mixed> */
    private function supportVerificationRequired(int $customerId): array
    {
        if ($customerId > 0) {
            return [
                'status' => 'error',
                'reason' => 'customer_contact_unavailable',
                'message' => __('Your account email could not be verified. Please contact support directly.')->render(),
            ];
        }

        return [
            'status' => 'requires_customer_action',
            'reason' => 'guest_access_required',
            'purpose' => 'support',
            'message' => __('Verify your email before starting human support.')->render(),
        ];
    }

    /** @return array{store_id:int,website_id:int} */
    private function currentStoreScope(): array
    {
        $store = $this->storeManager->getStore();
        return [
            'store_id' => (int)$store->getId(),
            'website_id' => (int)$store->getWebsiteId(),
        ];
    }

    /**
     * The source conversation is both the ownership proof and the source of
     * the ticket's store/website boundary. A verified email must never allow a
     * shopper to create or discover a support thread from another storefront.
     *
     * @param array{store_id:int,website_id:int} $scope
     */
    private function getOwnedSourceConversation(
        int $conversationId,
        ?int $customerId,
        string $guestId,
        array $scope
    ): ?array {
        if ($conversationId < 1) {
            return null;
        }

        $connection = $this->resource->getConnection();
        $select = $connection->select()
            ->from($this->resource->getTableName('afd_ai_conversation'), ['conversation_id'])
            ->where('conversation_id = ?', $conversationId)
            ->where('conversation_type = ?', 'ai')
            ->where('store_id = ?', $scope['store_id'])
            ->where('website_id = ?', $scope['website_id'])
            ->limit(1);
        if (($customerId ?? 0) > 0) {
            $select->where('customer_id = ?', (int)$customerId);
        } elseif (preg_match('/^[a-f0-9]{64}$/', $guestId)) {
            $select->where('guest_id = ?', $guestId);
        } else {
            return null;
        }

        $source = $connection->fetchRow($select);
        return is_array($source) && $source !== [] ? $source : null;
    }

    private function createPublicId(): string
    {
        return 'AI-' . strtoupper(substr($this->random->getRandomString(16), 0, 12));
    }

    private function encodeContext(array $context): ?string
    {
        $allowed = ['order_number', 'product_skus', 'page_url', 'tool_error', 'locale'];
        $safe = [];
        foreach ($allowed as $key) {
            if (!array_key_exists($key, $context)) {
                continue;
            }
            if ($key === 'product_skus' && is_array($context[$key])) {
                $safe[$key] = array_values(array_slice(array_filter(array_map(
                    static fn ($sku) => mb_substr(trim((string)$sku), 0, 64),
                    $context[$key]
                )), 0, 20));
                continue;
            }
            $safe[$key] = mb_substr(trim((string)$context[$key]), 0, 500);
        }
        return $safe ? json_encode($safe, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null;
    }
}
