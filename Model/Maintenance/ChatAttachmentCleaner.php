<?php
declare(strict_types=1);

namespace Afd\AI\Model\Maintenance;

use Afd\AI\Model\Config\Config as AiConfig;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Filesystem;
use Magento\Framework\Filesystem\Directory\WriteInterface;
use Psr\Log\LoggerInterface;

/** Removes old attachment files that are no longer referenced by a message. */
class ChatAttachmentCleaner
{
    private const BASE_PATH = 'afd_ai/chat';
    private const MAX_FILES_PER_RUN = 500;

    private WriteInterface $varDirectory;

    public function __construct(
        Filesystem $filesystem,
        private readonly ResourceConnection $resource,
        private readonly AiConfig $config,
        private readonly LoggerInterface $logger
    ) {
        $this->varDirectory = $filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
    }

    public function execute(?int $now = null): int
    {
        $now ??= time();
        if (!$this->varDirectory->isExist(self::BASE_PATH)) {
            return 0;
        }

        $limits = $this->config->getAttachmentConfig();
        $retention = (int)($limits['orphan_retention_seconds'] ?? 604800);
        $cutoff = $now - max(3600, $retention);

        // Magento's Directory::search() is glob-based, not recursive. Customer
        // paths have owner/conversation/file, while guest paths add one hashed
        // owner segment, so enumerate both exact layouts deliberately.
        $files = array_values(array_unique(array_merge(
            $this->varDirectory->search('*/*/*', self::BASE_PATH),
            $this->varDirectory->search('*/*/*/*', self::BASE_PATH)
        )));
        $candidates = [];
        $unrecognized = 0;
        foreach ($files as $relativePath) {
            if (!$this->isAttachmentFile($relativePath)) {
                $unrecognized++;
                continue;
            }
            try {
                $modifiedAt = (int)($this->varDirectory->stat($relativePath)['mtime'] ?? 0);
                if ($modifiedAt > 0 && $modifiedAt <= $cutoff) {
                    $candidates[] = ['path' => $relativePath, 'modified_at' => $modifiedAt];
                }
            } catch (\Throwable $exception) {
                $this->logger->warning('Afd AI attachment cleanup could not inspect a file.', [
                    'exception' => $exception,
                ]);
            }
        }

        // Select the oldest files first. Slicing a glob result is unfair:
        // unchanged low-sort entries can otherwise starve older files forever.
        usort($candidates, static fn (array $left, array $right): int => [
            $left['modified_at'], $left['path']
        ] <=> [
            $right['modified_at'], $right['path']
        ]);
        $candidates = array_slice($candidates, 0, self::MAX_FILES_PER_RUN);
        if ($candidates === []) {
            $this->logRun(count($files), 0, 0, 0, 0, $unrecognized, (bool)($limits['cleanup_dry_run'] ?? false));
            return 0;
        }

        // Restrict the database query to the same bounded cleanup batch. A
        // store with a long message history must not load every attachment row
        // just to decide whether these 500 filesystem candidates are orphaned.
        $candidatePaths = array_column($candidates, 'path');
        $references = $this->loadReferencedFiles($this->conversationIdsFromPaths($candidatePaths));
        $deleted = 0;
        $protected = 0;
        $wouldDelete = 0;
        $dryRun = (bool)($limits['cleanup_dry_run'] ?? false);
        foreach ($candidates as $candidate) {
            $relativePath = (string)$candidate['path'];
            try {
                $conversationId = $this->conversationIdFromPath($relativePath);
                if ($conversationId === null
                    || isset($references['protected_conversations'][$conversationId])
                    || isset($references['files'][$relativePath])) {
                    $protected++;
                    continue;
                }
                $wouldDelete++;
                if ($dryRun) {
                    continue;
                }
                $deleted += $this->varDirectory->delete($relativePath) ? 1 : 0;
            } catch (\Throwable $exception) {
                $this->logger->warning('Afd AI attachment cleanup skipped a file.', [
                    'path' => $relativePath,
                    'exception' => $exception,
                ]);
            }
        }

        $this->logRun(count($files), count($candidates), $protected, $wouldDelete, $deleted, $unrecognized, $dryRun);
        return $deleted;
    }

    /**
     * @return array{files:array<string, true>,protected_conversations:array<int, true>}
     */
    private function loadReferencedFiles(array $conversationIds): array
    {
        if ($conversationIds === []) {
            return ['files' => [], 'protected_conversations' => []];
        }
        $connection = $this->resource->getConnection();
        $messageTable = $this->resource->getTableName('afd_ai_message');
        $conversationTable = $this->resource->getTableName('afd_ai_conversation');
        $select = $connection->select()
            ->from(['m' => $messageTable], ['conversation_id', 'attachment'])
            ->joinLeft(
                ['c' => $conversationTable],
                'c.conversation_id = m.conversation_id',
                ['customer_id', 'guest_id']
            )
            ->where('m.attachment IS NOT NULL')
            ->where('m.attachment <> ?', '')
            ->where('m.conversation_id IN (?)', $conversationIds);

        $referenced = [];
        $protectedConversations = [];
        foreach ($connection->fetchAll($select) as $row) {
            $conversationId = (int)($row['conversation_id'] ?? 0);
            if ($conversationId < 1) {
                continue;
            }
            $ownerPath = $this->ownerPath($row['customer_id'] ?? null, $row['guest_id'] ?? null);
            if ($ownerPath === null) {
                $protectedConversations[$conversationId] = true;
                continue;
            }
            $payload = json_decode((string)($row['attachment'] ?? ''), true);
            if (!is_array($payload)) {
                $protectedConversations[$conversationId] = true;
                continue;
            }
            $items = is_array($payload['items'] ?? null) ? $payload['items'] : [$payload];
            foreach ($items as $item) {
                if (!is_array($item)) {
                    $protectedConversations[$conversationId] = true;
                    continue;
                }
                if ((string)($item['storage'] ?? '') !== 'private-v1') {
                    // A message containing an old or incomplete attachment
                    // payload protects its conversation from automatic file
                    // deletion. This is deliberately leak-safe, not delete-fast.
                    $protectedConversations[$conversationId] = true;
                    continue;
                }
                $url = (string)($item['url'] ?? '');
                $query = [];
                parse_str((string)parse_url($url, PHP_URL_QUERY), $query);
                $file = strtolower(trim((string)($query['file'] ?? '')));
                $urlConversationId = (int)($query['conversation_id'] ?? 0);
                if ($urlConversationId !== $conversationId
                    || !preg_match('/^[a-f0-9]{40}\.(?:jpg|png|webp)$/D', $file)) {
                    $protectedConversations[$conversationId] = true;
                    continue;
                }
                $referenced[self::BASE_PATH . '/' . $ownerPath . '/' . $conversationId . '/' . $file] = true;
            }
        }

        return ['files' => $referenced, 'protected_conversations' => $protectedConversations];
    }

    /** @param array<int, string> $paths @return array<int, int> */
    private function conversationIdsFromPaths(array $paths): array
    {
        $ids = [];
        foreach ($paths as $relativePath) {
            $conversationId = $this->conversationIdFromPath($relativePath);
            if ($conversationId !== null) {
                $ids[$conversationId] = true;
            }
        }
        return array_keys($ids);
    }

    private function isAttachmentFile(string $relativePath): bool
    {
        return $this->conversationIdFromPath($relativePath) !== null;
    }

    private function conversationIdFromPath(string $relativePath): ?int
    {
        if (preg_match(
            '#^' . preg_quote(self::BASE_PATH, '#') . '/(?:\d+|guest/[a-f0-9]{64})/(\d+)/[a-f0-9]{40}\.(?:jpg|png|webp)$#D',
            $relativePath,
            $matches
        ) !== 1) {
            return null;
        }
        $conversationId = (int)$matches[1];
        return $conversationId > 0 ? $conversationId : null;
    }

    private function logRun(
        int $scanned,
        int $candidates,
        int $protected,
        int $wouldDelete,
        int $deleted,
        int $unrecognized,
        bool $dryRun
    ): void {
        if ($scanned === 0 && $unrecognized === 0) {
            return;
        }
        $this->logger->info('Afd AI attachment cleanup completed.', [
            'scanned' => $scanned,
            'candidates' => $candidates,
            'protected' => $protected,
            'would_delete' => $wouldDelete,
            'deleted' => $deleted,
            'unrecognized' => $unrecognized,
            'dry_run' => $dryRun,
        ]);
    }

    private function ownerPath(mixed $customerId, mixed $guestId): ?string
    {
        if ((int)$customerId > 0) {
            return (string)(int)$customerId;
        }
        $guestId = strtolower(trim((string)$guestId));
        return preg_match('/^[a-f0-9]{64}$/', $guestId) ? 'guest/' . $guestId : null;
    }
}
