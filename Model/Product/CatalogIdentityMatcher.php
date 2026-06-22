<?php
declare(strict_types=1);

namespace Afd\AI\Model\Product;

/**
 * Language-neutral lexical identity check used only after an active catalogue
 * search returns no products. It prevents a close disabled product name from
 * being replaced by an unrelated category result.
 */
class CatalogIdentityMatcher
{
    /**
     * Return a bounded normalized prefix for the disabled-product lookup.
     *
     * @param string $query Product identity supplied by the catalogue agent.
     */
    public function searchPrefix(string $query): string
    {
        $tokens = $this->tokens($query);
        if ($tokens === []) {
            return '';
        }

        // Keep candidate retrieval deliberately coarse and let the bounded
        // identity-distance scorer make the decision. A long prefix loses the
        // correct candidate whenever a shopper omits or duplicates a letter
        // near the beginning (Luftbalons/Luftballons,
        // Sonenbrille/Sonnenbrille). Three leading characters still keep the
        // fallback set bounded while remaining tolerant of those common
        // one-character mistakes.
        return mb_substr($tokens[0], 0, min(3, mb_strlen($tokens[0])));
    }

    /**
     * Determine whether two product identity terms differ only slightly.
     *
     * @param string $query Product identity supplied by the catalogue agent.
     * @param string $candidate Product name stored in Magento.
     */
    public function isCloseMatch(string $query, string $candidate): bool
    {
        $queryTokens = array_values(array_filter(
            $this->tokens($query),
            static fn (string $token): bool => mb_strlen($token) >= 5
        ));
        $candidateTokens = $this->tokens($candidate);
        if ($queryTokens === [] || $candidateTokens === []) {
            return false;
        }

        foreach ($queryTokens as $queryToken) {
            foreach ($candidateTokens as $candidateToken) {
                $longest = max(strlen($queryToken), strlen($candidateToken));
                if ($longest < 5 || abs(strlen($queryToken) - strlen($candidateToken)) > 2) {
                    continue;
                }

                $distance = levenshtein($queryToken, $candidateToken);
                if ($distance <= max(1, (int)floor($longest * 0.18))) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Score a specific product identity, or return null for a broad/partial
     * match. Every meaningful query token must be represented in the product
     * name. Fewer extra candidate tokens means a closer identity.
     *
     * @param string $query Product identity supplied by the catalogue agent.
     * @param string $candidate Product name stored in Magento.
     */
    public function identityDistance(string $query, string $candidate): ?int
    {
        $queryTokens = array_values(array_filter(
            $this->tokens($query),
            static fn (string $token): bool => strlen($token) >= 3
        ));
        $candidateTokens = array_values(array_filter(
            $this->tokens($candidate),
            static fn (string $token): bool => strlen($token) >= 3
        ));
        if ($queryTokens === [] || $candidateTokens === []) {
            return null;
        }

        // A short single word such as "Herz" or "AfD" is a broad facet, not
        // a complete product identity. A distinctive long product term may
        // stand alone (for example Faltfächer or Fruchtbonbons).
        if (count($queryTokens) === 1 && strlen($queryTokens[0]) < 8) {
            return null;
        }

        $matchedCandidateIndexes = [];
        $editDistance = 0;
        foreach ($queryTokens as $queryToken) {
            $bestIndex = null;
            $bestDistance = PHP_INT_MAX;
            foreach ($candidateTokens as $index => $candidateToken) {
                $longest = max(strlen($queryToken), strlen($candidateToken));
                if (abs(strlen($queryToken) - strlen($candidateToken)) > 2) {
                    continue;
                }
                $distance = levenshtein($queryToken, $candidateToken);
                if ($distance <= max(1, (int)ceil($longest * 0.2)) && $distance < $bestDistance) {
                    $bestIndex = $index;
                    $bestDistance = $distance;
                }
            }
            if ($bestIndex === null) {
                return null;
            }
            $matchedCandidateIndexes[$bestIndex] = true;
            $editDistance += $bestDistance;
        }

        $extraCandidateTokens = count($candidateTokens) - count($matchedCandidateIndexes);

        return ($extraCandidateTokens * 3) + $editDistance;
    }

    /**
     * Normalize a product identity into language-neutral ASCII tokens.
     *
     * @param string $value Raw product identity.
     * @return string[]
     */
    private function tokens(string $value): array
    {
        $value = mb_strtolower(trim($value));
        if ($value === '') {
            return [];
        }

        $ascii = function_exists('transliterator_transliterate')
            ? transliterator_transliterate('Any-Latin; Latin-ASCII; Lower()', $value)
            : iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $value);
        $normalized = strtolower($ascii !== false ? $ascii : $value);
        $normalized = preg_replace('/[^a-z0-9]+/', ' ', $normalized) ?? '';

        return array_values(array_filter(
            preg_split('/\s+/', trim($normalized)) ?: [],
            static fn (string $token): bool => $token !== ''
        ));
    }
}
