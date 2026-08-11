<?php
declare(strict_types=1);

namespace Afd\AI\Api;

/** Boundary for optional Request-a-Quote implementations. */
interface QuoteCartAdapterInterface
{
    public function isAvailable(): bool;

    public function getCart(): ?object;
}
