function validHeightCentimetres(value) {
    const height = Number(value);
    return Number.isFinite(height) && height >= 80 && height <= 250;
}

function validWeightKilograms(value) {
    const weight = Number(String(value || '').replace(',', '.'));
    return Number.isFinite(weight) && weight >= 20 && weight <= 300;
}

function parsedBodyFitProfile(message = '') {
    const text = String(message || '');
    const metres = /\b([12])\s*(?:[.,]\s*(\d{1,2})|m\s*(\d{1,2}))\s*m?\b/iu.exec(text);
    const centimetres = /\b(\d{2,3}(?:[.,]\d{1,2})?)\s*cm\b/iu.exec(text);
    const kilograms = /\b(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:kg|kgs?|kilograms?)\b/iu.exec(text);

    const metresHeight = metres
        ? Number(metres[1]) * 100 + Number(String(metres[2] || metres[3] || '').padEnd(2, '0'))
        : null;
    const centimetresHeight = centimetres ? Number(String(centimetres[1]).replace(',', '.')) : null;
    const heightCm = metresHeight || centimetresHeight;
    const weightKg = kilograms ? Number(String(kilograms[1]).replace(',', '.')) : null;

    if (!validHeightCentimetres(heightCm) || !validWeightKilograms(weightKg)) return null;
    return Object.freeze({ heightCm, weightKg });
}

/**
 * Detect only the unit-bearing physical profile itself.  This deliberately
 * avoids language or product-name dictionaries: both measurements must be
 * plausible before the catalogue flow changes.
 */
export function hasBodyFitProfile(message = '') {
    return parsedBodyFitProfile(message) !== null;
}

/**
 * A named standard size is an explicit shopper requirement, not an inferred
 * recommendation.  The normal hard-attribute contract will still require
 * Magento to verify its attribute code and option values before a product
 * search can run.
 */
export function hasExplicitStandardSize(message = '') {
    return /(?<![\p{L}\p{N}])(?:xxs|xs|s|m|l|xl|xxl|[2-9]xl)(?![\p{L}\p{N}])/iu.test(String(message || ''));
}

/**
 * Return a conservative standard-size range from the measurements a shopper
 * actually supplied.  This is a shopping-discovery hint, never proof that a
 * garment fits: the gateway still requires Magento to verify the selectable
 * size on every returned card.  The calculation is deliberately based on
 * height and weight only, so it remains language and store independent.
 */
export function inferBodyFitSizeRange(message = '') {
    if (hasExplicitStandardSize(message)) return null;
    const profile = parsedBodyFitProfile(message);
    if (!profile) return null;

    const heightMetres = profile.heightCm / 100;
    const bmi = profile.weightKg / (heightMetres * heightMetres);
    let candidates;
    if (bmi < 18.5) candidates = ['XS', 'S'];
    else if (bmi < 23) candidates = ['S', 'M'];
    else if (bmi < 27.5) candidates = ['M', 'L'];
    else if (bmi < 32.5) candidates = ['L', 'XL'];
    else if (bmi < 37.5) candidates = ['XXL', '3XL'];
    else candidates = ['3XL', '4XL'];

    return Object.freeze({
        ...profile,
        bmi: Number(bmi.toFixed(1)),
        candidates: Object.freeze(candidates)
    });
}

/**
 * Provider-neutral dynamic instruction. It lets the model give a useful
 * first recommendation from the supplied profile while keeping Magento as
 * the authority for the actual available sizes and products.
 */
export function bodyFitSizingInstruction(message = '') {
    const range = inferBodyFitSizeRange(message);
    if (!range) return '';

    return `BODY-PROFILE PRODUCT DISCOVERY FOR THIS TURN\n`
        + `- The shopper supplied ${range.heightCm} cm and ${range.weightKg} kg. Use the estimated standard-size range ${range.candidates.join(' or ')} as a practical shopping filter; do not ask for extra body measurements before searching.\n`
        + `- It is an estimate, not a guarantee of fit. Explain that briefly only after Magento has found products.\n`
        + `- Treat the estimated range exactly like a selectable size requirement: first discover a relevant category and its real configurable attributes, then search only with the Magento-returned size attribute and one or more exact returned values matching ${range.candidates.join(' or ')}. Do not show a broad category grid or a product without one of those verified sizes.\n`
        + `- If the category has no matching selectable size values, say that the shop cannot verify a size-based match from its current product data; you may then offer only a clearly labelled, verified same-product-family alternative if the shopper asked for suggestions.`;
}
