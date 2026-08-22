<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config\Backend;

/**
 * Backwards-compatible alias for Magento's encrypted configuration backend.
 *
 * Older installations used this class for values that were rendered as
 * visible text. Keeping the alias lets those installations upgrade without a
 * config-path change while ensuring every subsequent save is encrypted.
 */
class VisibleValue extends \Magento\Config\Model\Config\Backend\Encrypted
{
}
