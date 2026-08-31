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

    public function testBuildsABoundedCandidatePrefixFromTheMostDistinctiveIdentityToken(): void
    {
        $matcher = new CatalogIdentityMatcher();

        self::assertSame('fre', $matcher->searchPrefix('Tase Freiheit'));
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

    public function testIgnoresAShortGenericTitlePrefixWhenFindingAnExactProduct(): void
    {
        $matcher = new CatalogIdentityMatcher();

        self::assertSame('jet', $matcher->searchPrefix('T-Shirt "#jetztafd"'));
        self::assertSame(0, $matcher->identityDistance(
            'T-Shirt "#jetztafd"',
            'T-Shirt "#jetztafd"'
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

    public function testRequiresExactNormalizedTokenEvidenceBeforeTreatingAFulltextCardAsRelevant(): void
    {
        $matcher = new CatalogIdentityMatcher();

        self::assertTrue($matcher->hasLexicalOverlap(
            'Regenschirm hellblau AfD',
            'Regenschirm hellblau "AfD"'
        ));
        self::assertFalse($matcher->hasLexicalOverlap(
            'Regenschirm hellblau AfD',
            'Metall-Kugelschreiber "Mut zur Wahrheit"'
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

    public function testRecognizesACompleteTitleEmbeddedInAShopperSentenceWithoutMatchingAReorderedTitle(): void
    {
        $matcher = new CatalogIdentityMatcher();

        self::assertNotNull($matcher->embeddedIdentityDistance(
            'Tôi muốn tìm Regenschrim hellblau AfD',
            'Regenschirm hellblau "AfD"'
        ));
        self::assertNull($matcher->embeddedIdentityDistance(
            'Tôi muốn tìm Regenschrim hellblau AfD',
            'Regenschirm dunkelblau "AfD"'
        ));
    }
}
