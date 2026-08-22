<?php
declare(strict_types=1);

namespace Afd\AI\Api;

use Afd\AI\Api\Data\ProviderInterface;
use Magento\Framework\Exception\NoSuchEntityException;
use Magento\Framework\Exception\CouldNotSaveException;
use Magento\Framework\Exception\CouldNotDeleteException;

interface ProviderRepositoryInterface
{
    /**
     * @param ProviderInterface $provider
     * @return ProviderInterface
     * @throws CouldNotSaveException
     */
    public function save(ProviderInterface $provider): ProviderInterface;

    /**
     * @param int $providerId
     * @return ProviderInterface
     * @throws NoSuchEntityException
     */
    public function getById(int $providerId): ProviderInterface;

    /**
     * @param string $providerCode
     * @return ProviderInterface
     * @throws NoSuchEntityException
     */
    public function getByCode(string $providerCode): ProviderInterface;

    /**
     * @param ProviderInterface $provider
     * @return bool
     * @throws CouldNotDeleteException
     */
    public function delete(ProviderInterface $provider): bool;

    /**
     * @param int $providerId
     * @return bool
     * @throws CouldNotDeleteException
     * @throws NoSuchEntityException
     */
    public function deleteById(int $providerId): bool;

    /**
     * @param bool $onlyActive
     * @return ProviderInterface[]
     */
    public function getList(bool $onlyActive = false): array;
}
