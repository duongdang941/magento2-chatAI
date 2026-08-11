<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Order;

class FakeOrderAddress
{
    /** @var array<string, mixed> */
    public array $data = [
        'firstname' => '', 'lastname' => '', 'company' => '', 'street' => [],
        'city' => '', 'region' => '', 'region_id' => 0, 'region_code' => '',
        'postcode' => '', 'country_id' => 'DE', 'telephone' => '', 'fax' => '',
        'vat_id' => '', 'prefix' => '', 'middlename' => '', 'suffix' => '', 'email' => '',
    ];

    public function __call(string $name, array $arguments): mixed
    {
        $property = lcfirst(substr($name, 3));
        $field = strtolower((string)preg_replace('/(?<!^)[A-Z]/', '_$0', $property));
        if (str_starts_with($name, 'get')) {
            return $this->data[$field] ?? null;
        }
        if (str_starts_with($name, 'set')) {
            $this->data[$field] = $arguments[0] ?? null;
            return $this;
        }
        return null;
    }
}
