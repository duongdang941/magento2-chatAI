<?php
declare(strict_types=1);

namespace Afd\AI\Model\Data;

use Afd\AI\Api\Data\ToolResponseInterface;
use Magento\Framework\DataObject;

class ToolResponse extends DataObject implements ToolResponseInterface
{
    /**
     * @inheritDoc
     */
    public function getData($key = '', $index = null)
    {
        if ($key !== '' || $index !== null) {
            return parent::getData($key, $index);
        }

        return parent::getData('data') ?? [];
    }

    /**
     * @inheritDoc
     */
    public function setData($key, $value = null)
    {
        if (func_num_args() === 1) {
            return parent::setData('data', $key);
        }

        return parent::setData($key, $value);
    }

    /**
     * @inheritDoc
     */
    public function getHtml(): ?string
    {
        return $this->getData('html');
    }

    /**
     * @inheritDoc
     */
    public function setHtml(string $html)
    {
        return $this->setData('html', $html);
    }

    /**
     * @inheritDoc
     */
    public function getMeta(): array
    {
        $meta = $this->getData('meta');
        return is_array($meta) ? $meta : [];
    }

    /**
     * @inheritDoc
     */
    public function setMeta(array $meta)
    {
        return $this->setData('meta', $meta);
    }
}
