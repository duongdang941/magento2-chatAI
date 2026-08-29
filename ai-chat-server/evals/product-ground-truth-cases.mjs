const activeExact = [
    ['active-luftballons', 'Cửa hàng có sản phẩm Luftballons không? Tìm đúng sản phẩm đó cho tôi.', '021.A403'],
    ['active-warnweste', 'Tôi muốn tìm Warnweste "AfD", cửa hàng có bán không?', '022.F001'],
    ['active-strickmuetze', 'Shop có Strickmütze "AfD" không?', '022.G104'],
    ['active-herz-keyring', 'Tìm giúp tôi Herz-Schlüsselanhänger.', '021.F301'],
    ['active-tasse-freiheit', 'Cửa hàng có Tasse "Freiheit" không?', 'N021.B4012'],
    ['active-grillzange', 'Tôi cần tìm Grillzange "AfD".', 'N023.G302'],
    ['active-regenschirm', 'Có bán Regenschirm hellblau "AfD" không?', 'N021.C103'],
    ['active-eiskratzer', 'Tìm đúng sản phẩm Eiskratzer "AfD" cho tôi.', '021.H802'],
    ['active-verfassungsschutz-sticker', 'Shop có Aufkleber "Verfassungsschutz" không?', 'N024.H6015'],
    ['active-papierfaehnchen', 'Tôi muốn mua Papierfähnchen AfD.', 'N021.B7014'],
    ['active-hissfahne', 'Tìm Hissfahne geöst "AfD" 150 x 90 cm.', '023.A604-1'],
    ['active-blue-shirt', 'Có T-Shirt blau personalisierbar không?', 'N022.A00'],
    ['active-zukunftsplan', 'Tìm Faltblatt "Zukunftsplan".', 'N054.A8B47'],
    ['active-sunglasses', 'Shop có Sonnenbrille "Deutschland im Blick" chứ?', '021.G501'],
    ['active-election-2026', 'Tìm Wahlprogramm 2026 - BW26 cho tôi.', '114.B5O38']
].map(([id, prompt, sku]) => ({ id, group: 'active_exact', prompt, expectedSkus: [sku] }));

const activeTypos = [
    ['typo-luftballons', 'Cửa hàng có Luftbalons không?', '021.A403'],
    ['typo-warnweste', 'Tìm sản phẩm Warnveste AfD cho tôi.', '022.F001'],
    ['typo-strickmuetze', 'Shop có Strickmutze AfD không?', '022.G104'],
    ['typo-herz-keyring', 'Tìm Herz Schlusselanhanger giúp tôi.', '021.F301'],
    ['typo-tasse', 'Có Tase Freiheit không?', 'N021.B4012'],
    ['typo-regenschirm', 'Tôi muốn tìm Regenschrim hellblau AfD.', 'N021.C103'],
    ['typo-verfassungsschutz-sticker', 'Shop có Aufkleber Verfassungschuz không?', 'N024.H6015'],
    ['typo-papierfaehnchen', 'Tìm Papierfahnchen AfD cho tôi.', 'N021.B7014'],
    ['typo-sunglasses', 'Có Sonenbrille Deutschland im Blick không?', '021.G501'],
    ['typo-election-2026', 'Tìm Wahlprogram 2026 BW26.', '114.B5O38']
].map(([id, prompt, sku]) => ({ id, group: 'active_typo', prompt, expectedSkus: [sku] }));

const disabledExact = [
    ['disabled-aschenbecher', 'Shop có Aschenbecher "AfD" không?', ['021.H901']],
    ['disabled-lighter', 'Cửa hàng có Feuerzeug "Mein Herz brennt..." không?', ['021.A204']],
    ['disabled-osterhase', 'Tôi muốn mua Schokoladen-Osterhase 21er-Zylinderbox.', ['021.E103']],
    ['disabled-security-leaflet', 'Shop có Themenfaltblatt "Innere Sicherheit" không?', ['024.A8B5-1']],
    ['disabled-mut-deutschland', 'Tìm Programm-Faltblatt "Mut zu Deutschland".', ['024.A8B7-1']],
    ['disabled-lockdown', 'Có Faltblatt "Corona-Lockdown" không?', ['024.A8B4-1']],
    ['disabled-usb', 'Tìm USB-Stick "AfD" 32GB cho tôi.', ['021.B203']],
    ['disabled-spendenkarte', 'Cửa hàng có Spendenkarte "Deutschland. Aber normal." bản thường, không phải bản indiv không?', ['024.C903-2']],
    ['disabled-germany-flag', 'Tìm Schwenkfahne "Deutschland" 150 x 90 cm, không lấy mẫu AfD.', ['023.A603-1']],
    ['disabled-blue-chip', 'Shop có Einkaufswagenchips blau không?', ['021.A301-1']]
].map(([id, prompt, disabledSkus]) => ({ id, group: 'disabled', prompt, disabledSkus }));

const absentExact = [
    ['absent-galaxy-mug', 'Cửa hàng có đúng sản phẩm Galaxy Mug 9000 không?', 'Galaxy Mug 9000'],
    ['absent-moon-fan', 'Tôi muốn tìm Faltfächer "Monduntergang", có sản phẩm đó không?', 'Faltfächer Monduntergang'],
    ['absent-mars-jacket', 'Shop có Jacke "Mars Edition" không?', 'Jacke Mars Edition'],
    ['absent-usb-1tb', 'Tìm đúng USB-Stick 1TB Gold Edition.', 'USB-Stick 1TB Gold Edition'],
    ['absent-unicorn-poster', 'Cửa hàng có Poster "Unicorn Rainbow" không?', 'Poster Unicorn Rainbow'],
    ['absent-cat-cap', 'Tìm Kappe neonpink Katzen Edition.', 'Kappe neonpink Katzen Edition'],
    ['absent-giant-umbrella', 'Có Regenschirm transparent 5 Meter không?', 'Regenschirm transparent 5 Meter'],
    ['absent-quantum-leaflet', 'Tôi cần Faltblatt "Quantencomputer".', 'Faltblatt Quantencomputer'],
    ['absent-volcano-keyring', 'Shop có Schlüsselanhänger "Vulkan" không?', 'Schlüsselanhänger Vulkan'],
    ['absent-lunar-calendar', 'Tìm Kalender "Mondbasis 2035" cho tôi.', 'Kalender Mondbasis 2035']
].map(([id, prompt, requestedName]) => ({ id, group: 'absent', prompt, requestedName }));

const broadSearches = [
    ['broad-shirt', 'Tìm cho tôi một vài sản phẩm áo thun đang bán.', ['t-shirt', 'shirt']],
    ['broad-hat', 'Cửa hàng hiện có những loại mũ nào?', ['mütze', 'kappe', 'cap']],
    ['broad-cup', 'Tìm các sản phẩm cốc hoặc ly đang bán.', ['tasse', 'becher']],
    ['broad-flag', 'Cho tôi xem một vài sản phẩm cờ đang bán.', ['fahne', 'flag']],
    ['broad-leaflet', 'Tìm một vài tờ rơi hoặc tờ gấp đang bán.', ['faltblatt', 'flyer', 'handzettel']]
].map(([id, prompt, allowedNameTokens]) => ({ id, group: 'broad', prompt, allowedNameTokens }));

export const productGroundTruthCases = [
    ...activeExact,
    ...activeTypos,
    ...disabledExact,
    ...absentExact,
    ...broadSearches
];

if (productGroundTruthCases.length !== 50) {
    throw new Error(`Expected 50 product ground-truth cases, got ${productGroundTruthCases.length}.`);
}
