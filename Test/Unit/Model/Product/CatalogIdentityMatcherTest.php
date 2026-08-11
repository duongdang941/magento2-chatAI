<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Product;

use Afd\AI\Model\Product\CatalogIdentityMatcher;
use PHPUnit\Framework\TestCase;

class CatalogIdentityMatcherTest extends TestCase
{
    public function testRecognizesAOneCharacterProductNameTypo(): void
    {
        $matcher = new CatalogIdentityMatcher();

        self::assertTrue($matcher->isCloseMatch(
            'Faltfächel',
            'Faltfächer "Sonnenaufgang"'
        ));
    }

    public function testBuildsABoundedCandidatePrefixForAShortInsertionTypo(): void
    {
        $matcher = new CatalogIdentityMatcher();

        self::assertSame('tas', $matcher->searchPrefix('Tase Freiheit'));
        self::assertSame(1, $matcher->identityDistance(
            'Tase Freiheit',
            'Tasse "Freiheit"'
        ));
    }

    public function testKeepsLongIdentityPrefixesTolerantOfEarlyTypos(): void
    {
        $matcher = new CatalogIdentityMatcher();

        self::assertSame('luf', $matcher->searchPrefix('Luftbalons'));
        self::assertSame(1, $matcher->identityDistance('Luftbalons', 'Luftballons'));
        self::assertSame('son', $matcher->searchPrefix('Sonenbrille Deutschland im Blick'));
        self::assertSame(1, $matcher->identityDistance(
            'Sonenbrille Deutschland im Blick',
            'Sonnenbrille "Deutschland im Blick"'
        ));
    }

    public function testRejectsAnUnrelatedProductName(): void
    {
        $matcher = new CatalogIdentityMatcher();

        self::assertFalse($matcher->isCloseMatch(
            'Faltfächel',
            'Spendenkarte "Deutschland. Aber normal."'
        ));
    }

    public function testScoresACompleteDisabledIdentityCloserThanAnActiveAlternative(): void
    {
        $matcher = new CatalogIdentityMatcher();

        self::assertSame(0, $matcher->identityDistance(
            'Spendenkarte Deutschland Aber normal',
            'Spendenkarte "Deutschland. Aber normal."'
        ));
        self::assertSame(3, $matcher->identityDistance(
            'Spendenkarte Deutschland Aber normal',
            'Spendenkarte "Deutschland. Aber normal." (indiv.)'
        ));
        self::assertNull($matcher->identityDistance(
            'Schwenkfahne Deutschland 150 90',
            'Schwenkfahne "AfD" 120 x 80 cm'
        ));
    }

    public function testDoesNotTreatAShortBroadFacetAsAProductIdentity(): void
    {
        $matcher = new CatalogIdentityMatcher();

        self::assertNull($matcher->identityDistance('Herz', 'Feuerzeug "Mein Herz brennt..."'));
    }
}
