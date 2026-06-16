<?php
declare(strict_types=1);

namespace Afd\AI\Api\Data;

interface ToolResponseInterface
{
    /**
     * Get data
     *
     * @return mixed
     */
    public function getData();

    /**
     * Set data
     *
     * @param mixed $data
     * @return $this
     */
    public function setData($data);

    /**
     * Get HTML
     *
     * @return string|null
     */
    public function getHtml(): ?string;

    /**
     * Set HTML
     *
     * @param string $html
     * @return $this
     */
    public function setHtml(string $html);

    /**
     * Optional, structured metadata for a tool response.
     *
     * Catalogue search uses this for pagination. Keeping it separate from
     * `data` preserves backwards compatibility with existing tool consumers.
     *
     * @return array<string, mixed>
     */
    public function getMeta(): array;

    /**
     * @param array<string, mixed> $meta
     * @return $this
     */
    public function setMeta(array $meta);
}
