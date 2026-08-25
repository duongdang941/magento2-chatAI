<?php
declare(strict_types=1);

namespace Afd\AI\Console\Command;

use DateTimeImmutable;
use DateTimeZone;
use Afd\AI\Model\ChatAttachmentStorage;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\App\ResourceConnection;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * Imports the one-time local JSONL history created before DB-only storage.
 */
class MigrateLegacyJsonlHistoryCommand extends Command
{
    private const OPTION_DRY_RUN = 'dry-run';

    private DirectoryList $directoryList;
    private ResourceConnection $resourceConnection;
    private ChatAttachmentStorage $chatAttachmentStorage;

    public function __construct(
        DirectoryList $directoryList,
        ResourceConnection $resourceConnection,
        ChatAttachmentStorage $chatAttachmentStorage
    ) {
        parent::__construct();
        $this->directoryList = $directoryList;
        $this->resourceConnection = $resourceConnection;
        $this->chatAttachmentStorage = $chatAttachmentStorage;
    }

    protected function configure(): void
    {
        $this->setName('afd:ai:history:migrate-legacy-jsonl')
            ->setDescription('Import legacy Afd AI JSONL transcripts into the Magento message table once.')
            ->addOption(
                self::OPTION_DRY_RUN,
                null,
                InputOption::VALUE_NONE,
                'Validate source transcripts and show the import plan without writing messages.'
            );
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $root = $this->directoryList->getPath(DirectoryList::VAR_DIR) . '/afd-ai/transcripts';
        $files = glob($root . '/*/*.jsonl') ?: [];
        if ($files === []) {
            $output->writeln('<info>No legacy JSONL transcripts found.</info>');
            return Command::SUCCESS;
        }

        $dryRun = (bool)$input->getOption(self::OPTION_DRY_RUN);
        $connection = $this->resourceConnection->getConnection();
        $conversationTable = $this->resourceConnection->getTableName('afd_ai_conversation');
        $messageTable = $this->resourceConnection->getTableName('afd_ai_message');
        $summary = [
            'files' => 0,
            'conversations' => 0,
            'messages' => 0,
            'attachments' => 0,
            'migrated_attachments' => 0,
            'skipped_existing' => 0,
            'skipped_invalid' => 0
        ];

        foreach ($files as $file) {
            $summary['files']++;
            $customerId = (int)basename(dirname($file));
            $conversationId = (int)pathinfo($file, PATHINFO_FILENAME);
            if ($customerId < 1 || $conversationId < 1) {
                $summary['skipped_invalid']++;
                continue;
            }

            $conversationCustomerId = $connection->fetchOne(
                $connection->select()
                    ->from($conversationTable, ['customer_id'])
                    ->where('conversation_id = ?', $conversationId)
            );
            if ((int)$conversationCustomerId !== $customerId) {
                $summary['skipped_invalid']++;
                continue;
            }

            $records = $this->readRecords($file, $summary);
            if ($records === []) {
                $summary['skipped_invalid']++;
                continue;
            }

            $messageCount = (int)$connection->fetchOne(
                $connection->select()
                    ->from($messageTable, ['message_count' => 'COUNT(*)'])
                    ->where('conversation_id = ?', $conversationId)
            );
            if ($messageCount > 0) {
                $summary['skipped_existing']++;
                $summary['migrated_attachments'] += $this->migrateExistingAttachments(
                    $records,
                    $customerId,
                    $conversationId,
                    $messageTable,
                    $dryRun
                );
                continue;
            }

            $rows = $this->buildRows($records, $customerId, $conversationId);
            $attachmentPayloads = $this->collectAttachmentPayloads($records);

            if (!$dryRun) {
                $connection->beginTransaction();
                try {
                    $connection->insertMultiple($messageTable, $rows);
                    // Files are stored only after the row insert succeeded but
                    // before commit, so a failure cannot orphan quota-counted
                    // files waiting on the weekly sweep.
                    $this->storeAttachmentsWithinTransaction(
                        $attachmentPayloads,
                        $customerId,
                        $conversationId,
                        $messageTable
                    );
                    $connection->commit();
                } catch (\Throwable $exception) {
                    $connection->rollBack();
                    // The rolled-back rows no longer reference these files.
                    try {
                        $this->chatAttachmentStorage->deleteConversationAttachments($customerId, $conversationId);
                    } catch (\Throwable $cleanupException) {
                        $output->writeln(sprintf(
                            '<comment>Attachment cleanup after failed import failed: %s</comment>',
                            $cleanupException->getMessage()
                        ));
                    }
                    throw $exception;
                }
            }

            $summary['conversations']++;
            $summary['messages'] += count($rows);
        }

        $mode = $dryRun ? 'Would import' : 'Imported';
        $output->writeln(sprintf(
            '<info>%s %d messages from %d conversations.</info>',
            $mode,
            $summary['messages'],
            $summary['conversations']
        ));
        $output->writeln(sprintf(
            'Skipped existing: %d; invalid: %d; attachments found: %d; migrated: %d.',
            $summary['skipped_existing'],
            $summary['skipped_invalid'],
            $summary['attachments'],
            $summary['migrated_attachments']
        ));

        return Command::SUCCESS;
    }

    /**
     * @param array<string, int> $summary
     * @return array<int, array<string, mixed>>
     */
    private function readRecords(string $file, array &$summary): array
    {
        try {
            $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        } catch (\Throwable $exception) {
            return [];
        }

        if (!is_array($lines)) {
            return [];
        }

        $records = [];
        foreach ($lines as $line) {
            try {
                $record = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
            } catch (\JsonException $exception) {
                return [];
            }
            if (!is_array($record) || !is_string($record['content'] ?? null)) {
                return [];
            }

            if (isset($record['attachment'])) {
                $summary['attachments']++;
            }
            $records[] = $record;
        }

        return $records;
    }

    /**
     * Rows are built file-free; attachment payloads are stored only from
     * storeAttachmentsWithinTransaction() after the rows exist.
     *
     * @param array<int, array<string, mixed>> $records
     * @return array<int, array<string, string|int>>
     */
    private function buildRows(array $records, int $customerId, int $conversationId): array
    {
        $rows = [];
        foreach ($records as $record) {
            $role = ($record['role'] ?? '') === 'assistant' ? 'assistant' : 'user';
            $rows[] = [
                'session_id' => 'legacy-jsonl-import',
                'customer_id' => $customerId,
                'conversation_id' => $conversationId,
                'role' => $role,
                'content' => $record['content'],
                'attachment' => null,
                'created_at' => $this->normalizeTimestamp($record['created_at'] ?? null)
            ];
        }

        return $rows;
    }

    /**
     * Attachment payloads in user-message order; dry-run stays file-free by
     * only ever consuming this list inside the non-dry-run transaction.
     *
     * @param array<int, array<string, mixed>> $records
     * @return array<int, array<string, mixed>>
     */
    private function collectAttachmentPayloads(array $records): array
    {
        $payloads = [];
        foreach ($records as $record) {
            if (($record['role'] ?? '') === 'assistant') {
                continue;
            }
            if (isset($record['attachment']) && is_array($record['attachment'])) {
                $payloads[] = $record['attachment'];
            }
        }

        return $payloads;
    }

    /**
     * Stores each pending attachment and writes the returned metadata onto its
     * inserted message row. Runs on an open per-conversation transaction so a
     * rollback removes the rows; execute() deletes any already-stored files.
     *
     * @param array<int, array<string, mixed>> $payloads
     */
    private function storeAttachmentsWithinTransaction(
        array $payloads,
        int $customerId,
        int $conversationId,
        string $messageTable
    ): void {
        if ($payloads === []) {
            return;
        }

        $connection = $this->resourceConnection->getConnection();
        $userRows = array_values(array_filter(
            $connection->fetchAll(
                $connection->select()
                    ->from($messageTable, ['entity_id', 'role'])
                    ->where('conversation_id = ?', $conversationId)
                    ->order('entity_id ASC')
            ),
            static fn (array $row): bool => ($row['role'] ?? '') === 'user'
        ));
        // Same chronological user-order matching as migrateExistingAttachments().
        if (count($userRows) < count($payloads)) {
            throw new \RuntimeException('Legacy import could not match inserted message rows for attachments.');
        }

        foreach (array_values($payloads) as $index => $payload) {
            $metadata = $this->chatAttachmentStorage->storeFromPayload(
                $payload,
                $customerId,
                $conversationId
            );
            $connection->update(
                $messageTable,
                ['attachment' => $metadata],
                ['entity_id = ?' => (int)$userRows[$index]['entity_id']]
            );
        }
    }

    /**
     * Older runs imported text but deliberately skipped base64 images. Match legacy user
     * records to their DB rows by chronological user-message order and fill only empty metadata.
     *
     * @param array<int, array<string, mixed>> $records
     */
    private function migrateExistingAttachments(
        array $records,
        int $customerId,
        int $conversationId,
        string $messageTable,
        bool $dryRun
    ): int {
        $connection = $this->resourceConnection->getConnection();
        $messages = $connection->fetchAll(
            $connection->select()
                ->from($messageTable, ['entity_id', 'content', 'attachment'])
                ->where('conversation_id = ?', $conversationId)
                ->where('role = ?', 'user')
                ->order('entity_id ASC')
        );
        $userIndex = 0;
        $migrated = 0;

        foreach ($records as $record) {
            if (($record['role'] ?? '') === 'assistant') {
                continue;
            }

            $message = $messages[$userIndex] ?? null;
            $userIndex++;
            if (!is_array($message) || !isset($record['attachment']) || !is_array($record['attachment'])) {
                continue;
            }

            if (trim((string)($message['attachment'] ?? '')) !== '') {
                continue;
            }

            // A content mismatch means the transcript no longer maps safely to this DB row.
            if ((string)$message['content'] !== (string)($record['content'] ?? '')) {
                continue;
            }

            if (!$dryRun) {
                $metadata = $this->chatAttachmentStorage->storeFromPayload(
                    $record['attachment'],
                    $customerId,
                    $conversationId
                );
                $connection->update(
                    $messageTable,
                    ['attachment' => $metadata],
                    ['entity_id = ?' => (int)$message['entity_id']]
                );
            }
            $migrated++;
        }

        return $migrated;
    }

    private function normalizeTimestamp(mixed $value): string
    {
        try {
            return (new DateTimeImmutable((string)$value))
                ->setTimezone(new DateTimeZone('UTC'))
                ->format('Y-m-d H:i:s');
        } catch (\Throwable $exception) {
            return gmdate('Y-m-d H:i:s');
        }
    }
}
