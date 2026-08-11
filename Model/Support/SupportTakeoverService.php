<?php
declare(strict_types=1);

namespace Afd\AI\Model\Support;

use Afd\AI\Model\Gateway\SupportMessagePublisher;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Exception\LocalizedException;

class SupportTakeoverService
{
    private const LEASE_SECONDS = 300;
    private const CLOSED_STATUSES = ['resolved', 'closed'];

    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly SupportMessagePublisher $publisher
    ) {
    }

    /** @return array<string, mixed> */
    public function claim(int $caseId, int $adminId, string $adminName): array
    {
        return $this->changeState($caseId, $adminId, $adminName, true);
    }

    /** @return array<string, mixed> */
    public function release(int $caseId, int $adminId, string $adminName): array
    {
        return $this->changeState($caseId, $adminId, $adminName, false);
    }

    public function heartbeat(int $caseId, int $adminId): bool
    {
        $now = gmdate('Y-m-d H:i:s');
        $expiresAt = gmdate('Y-m-d H:i:s', time() + self::LEASE_SECONDS);
        return $this->resource->getConnection()->update(
            $this->resource->getTableName('afd_ai_support_case'),
            ['takeover_expires_at' => $expiresAt, 'updated_at' => $now],
            [
                'entity_id = ?' => $caseId,
                'assigned_admin_id = ?' => $adminId,
                'takeover_state = ?' => 'active',
                'takeover_expires_at > ?' => $now,
            ]
        ) === 1;
    }

    /** @return array{active:bool,closed:bool,is_support:bool,status:string,agent_label:string,case_id:int} */
    public function getConversationState(
        int $conversationId,
        ?int $customerId,
        ?string $guestId
    ): array {
        if ($conversationId < 1) {
            return ['active' => false, 'closed' => false, 'is_support' => false, 'status' => '', 'agent_label' => '', 'case_id' => 0];
        }
        $connection = $this->resource->getConnection();
        $select = $connection->select()
            ->from(['support_case' => $this->resource->getTableName('afd_ai_support_case')])
            ->joinInner(
                ['conversation' => $this->resource->getTableName('afd_ai_conversation')],
                "conversation.conversation_id = support_case.conversation_id"
                    . " AND conversation.conversation_type = 'support'",
                []
            )
            ->joinLeft(
                ['admin_user' => $this->resource->getTableName('admin_user')],
                'admin_user.user_id = support_case.assigned_admin_id',
                ['admin_firstname' => 'firstname', 'admin_lastname' => 'lastname']
            )
            ->where('support_case.conversation_id = ?', $conversationId)
            ->order('support_case.entity_id DESC')
            ->limit(1);
        if (($customerId ?? 0) > 0) {
            $select->where('support_case.customer_id = ?', (int)$customerId);
        } else {
            $guestId = strtolower(trim((string)$guestId));
            if (!preg_match('/^[a-f0-9]{64}$/', $guestId)) {
                return ['active' => false, 'closed' => false, 'is_support' => false, 'status' => '', 'agent_label' => '', 'case_id' => 0];
            }
            $select->where('support_case.guest_id = ?', $guestId);
        }
        $case = $connection->fetchRow($select);
        if (!is_array($case) || $case === []) {
            return ['active' => false, 'closed' => false, 'is_support' => false, 'status' => '', 'agent_label' => '', 'case_id' => 0];
        }
        $status = (string)($case['status'] ?? 'open');
        $closed = in_array($status, self::CLOSED_STATUSES, true);
        return [
            'active' => !$closed,
            'closed' => $closed,
            'is_support' => true,
            'status' => $status,
            'agent_label' => $closed
                ? ''
                : (trim((string)$case['admin_firstname'] . ' ' . (string)$case['admin_lastname']) ?: (string)__('Support team')),
            'case_id' => (int)$case['entity_id'],
        ];
    }

    /** @return array<string, mixed> */
    private function changeState(int $caseId, int $adminId, string $adminName, bool $active): array
    {
        $connection = $this->resource->getConnection();
        $caseTable = $this->resource->getTableName('afd_ai_support_case');
        $connection->beginTransaction();
        try {
            $case = $connection->fetchRow(
                $connection->select()->from($caseTable)->where('entity_id = ?', $caseId)->forUpdate(true)
            );
            if (!is_array($case) || $case === []) {
                throw new LocalizedException(__('The support case no longer exists.'));
            }
            if (in_array((string)$case['status'], self::CLOSED_STATUSES, true)) {
                throw new LocalizedException(__('Reopen this case before starting a live chat.'));
            }
            if ((int)$case['conversation_id'] < 1) {
                throw new LocalizedException(__('This case is no longer linked to a conversation.'));
            }
            $currentActive = ($case['takeover_state'] ?? '') === 'active'
                && strtotime((string)($case['takeover_expires_at'] ?? '')) > time();
            if ($active && $currentActive && (int)$case['assigned_admin_id'] !== $adminId) {
                throw new LocalizedException(__('Another administrator is already chatting with this customer.'));
            }
            if (!$active && $currentActive && (int)$case['assigned_admin_id'] !== $adminId) {
                throw new LocalizedException(__('Only the administrator handling this chat can end it.'));
            }

            $now = gmdate('Y-m-d H:i:s');
            $connection->update($caseTable, $active ? [
                'assigned_admin_id' => $adminId,
                'status' => 'in_progress',
                'takeover_state' => 'active',
                'takeover_started_at' => $currentActive ? $case['takeover_started_at'] : $now,
                'takeover_expires_at' => gmdate('Y-m-d H:i:s', time() + self::LEASE_SECONDS),
                'takeover_ended_at' => null,
                'updated_at' => $now,
            ] : [
                'status' => 'waiting_customer',
                'takeover_state' => 'inactive',
                'takeover_expires_at' => null,
                'takeover_ended_at' => $now,
                'updated_at' => $now,
            ], ['entity_id = ?' => $caseId]);
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }

        $case['assigned_admin_id'] = $adminId;
        $case['takeover_state'] = $active ? 'active' : 'inactive';
        $this->publisher->publishMode($case, $active, $active ? $adminName : '');
        return $case;
    }
}
