import { Buffer } from 'node:buffer';

export const MAX_GENERATED_SVG_BYTES = 200 * 1024;

const ALLOWED_TAGS = new Set([
    'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse',
    'line', 'polyline', 'polygon', 'text', 'tspan', 'lineargradient',
    'radialgradient', 'stop', 'clippath', 'mask', 'filter', 'fegaussianblur',
    'fedropshadow', 'fecolormatrix', 'feoffset', 'feblend', 'feflood',
    'fecomposite', 'femerge', 'femergenode'
]);

const ALLOWED_ATTRIBUTES = new Set([
    'xmlns', 'xmlns:xlink', 'version', 'viewbox', 'width', 'height', 'x', 'y',
    'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
    'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity',
    'stroke-dasharray', 'stroke-dashoffset',
    'opacity', 'transform', 'id', 'class', 'offset', 'stop-color',
    'stop-opacity', 'clip-path', 'clip-rule', 'mask', 'preserveaspectratio',
    'text-anchor', 'font-family', 'font-size', 'font-weight', 'font-style',
    'letter-spacing', 'dominant-baseline', 'textlength', 'lengthadjust',
    'filter', 'filterunits', 'primitiveunits', 'in', 'in2', 'result',
    'stddeviation', 'dx', 'dy', 'flood-color', 'flood-opacity', 'type',
    'values', 'operator', 'k1', 'k2', 'k3', 'k4', 'mode',
    'color-interpolation-filters', 'aria-label', 'role', 'style'
]);

const TAG_NAMES = new Map([
    ['lineargradient', 'linearGradient'],
    ['radialgradient', 'radialGradient'],
    ['clippath', 'clipPath'],
    ['fegaussianblur', 'feGaussianBlur'],
    ['fedropshadow', 'feDropShadow'],
    ['fecolormatrix', 'feColorMatrix'],
    ['feoffset', 'feOffset'],
    ['feblend', 'feBlend'],
    ['feflood', 'feFlood'],
    ['fecomposite', 'feComposite'],
    ['femerge', 'feMerge'],
    ['femergenode', 'feMergeNode']
]);

const ATTRIBUTE_NAMES = new Map([
    ['viewbox', 'viewBox'],
    ['preserveaspectratio', 'preserveAspectRatio'],
    ['stop-color', 'stop-color'],
    ['stop-opacity', 'stop-opacity'],
    ['fill-opacity', 'fill-opacity'],
    ['fill-rule', 'fill-rule'],
    ['stroke-width', 'stroke-width'],
    ['stroke-linecap', 'stroke-linecap'],
    ['stroke-linejoin', 'stroke-linejoin'],
    ['stroke-miterlimit', 'stroke-miterlimit'],
    ['stroke-opacity', 'stroke-opacity'],
    ['stroke-dasharray', 'stroke-dasharray'],
    ['stroke-dashoffset', 'stroke-dashoffset'],
    ['clip-path', 'clip-path'],
    ['clip-rule', 'clip-rule'],
    ['text-anchor', 'text-anchor'],
    ['font-family', 'font-family'],
    ['font-size', 'font-size'],
    ['font-weight', 'font-weight'],
    ['font-style', 'font-style'],
    ['letter-spacing', 'letter-spacing'],
    ['dominant-baseline', 'dominant-baseline'],
    ['textlength', 'textLength'],
    ['lengthadjust', 'lengthAdjust'],
    ['filterunits', 'filterUnits'],
    ['primitiveunits', 'primitiveUnits'],
    ['stddeviation', 'stdDeviation'],
    ['flood-color', 'flood-color'],
    ['flood-opacity', 'flood-opacity'],
    ['color-interpolation-filters', 'color-interpolation-filters']
]);

const FORBIDDEN_VALUE = /(javascript\s*:|vbscript\s*:|data\s*:|<\/?script|<\/?foreignobject|expression\s*\(|@import|behavior\s*:|-moz-binding|\bon\w+\s*=|url\s*\(\s*["']?(?:https?:|data:|\/\/|javascript:))/i;
function fail(message) {
    const error = new Error(message);
    error.code = 'SVG_SANITIZATION_FAILED';
    return error;
}

function decodeAttributeValue(value) {
    return String(value || '')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&amp;/gi, '&')
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function validateAttributeValue(name, rawValue) {
    const value = decodeAttributeValue(rawValue).trim();
    if (FORBIDDEN_VALUE.test(value)) throw fail(`SVG attribute "${name}" contains a forbidden value.`);
    return value;
}

function parseAttributes(source, tagName) {
    const attributes = [];
    const seen = new Set();
    let cursor = 0;
    while (cursor < source.length) {
        while (/\s/.test(source[cursor] || '')) cursor += 1;
        if (cursor >= source.length) break;
        const match = source.slice(cursor).match(/^([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])(.*?)\2/s);
        if (!match) throw fail(`Malformed SVG attributes on <${tagName}>.`);
        const normalizedName = match[1].toLowerCase();
        if (normalizedName.startsWith('on')) throw fail('SVG event handler attributes are not allowed.');
        if (!ALLOWED_ATTRIBUTES.has(normalizedName)) throw fail(`SVG attribute "${normalizedName}" is not allowed.`);
        if (seen.has(normalizedName)) throw fail(`SVG attribute "${normalizedName}" is duplicated.`);
        seen.add(normalizedName);
        const value = validateAttributeValue(normalizedName, match[3]);
        attributes.push([ATTRIBUTE_NAMES.get(normalizedName) || normalizedName, value]);
        cursor += match[0].length;
    }
    return attributes;
}

/**
 * Validate and normalize a self-contained SVG generated by the chat model.
 * This intentionally uses a small XML lexer instead of a browser DOM: SVG is
 * never executed server-side and untrusted markup must be rejected before it
 * reaches Magento media storage or the storefront browser.
 */
export function sanitizeGeneratedSvg(input) {
    let source = String(input || '').replace(/^\uFEFF/, '').trim();
    if (!source) throw fail('SVG content is empty.');
    if (Buffer.byteLength(source, 'utf8') > MAX_GENERATED_SVG_BYTES) {
        throw fail('SVG content is larger than the permitted 200 KB limit.');
    }
    // XML declarations and comments are common harmless output from code
    // oriented models (including ZCode-style SVG artifacts). They carry no
    // rendered content, so remove them before lexing. Other declarations,
    // especially DOCTYPE/entity declarations, remain forbidden.
    source = source.replace(/<!--([\s\S]*?)-->/g, '');
    source = source.replace(/<\?xml(?:\s[^?]*)?\?>/gi, '');
    if (/<!--|<\?(?!xml\b)|<!(?:doctype|\[cdata\b)/i.test(source)
        || /<(?:script|foreignobject|iframe|object|embed)\b/i.test(source)) {
        throw fail('SVG contains a forbidden element or declaration.');
    }

    const tokens = source.match(/[^<]+|<[^>]*>/g) || [];
    if (tokens.join('') !== source) throw fail('Malformed SVG markup.');
    const stack = [];
    const output = [];
    let rootSeen = false;
    let rootClosed = false;
    let tagCount = 0;

    for (const token of tokens) {
        if (!token.startsWith('<')) {
            if (token.includes('<!--') || token.includes('<')) throw fail('Malformed SVG text.');
            output.push(token);
            continue;
        }
        if (/^<!--/.test(token) || /^<\?/.test(token) || /^<!/.test(token)) {
            throw fail('SVG comments and declarations are not allowed.');
        }

        const closing = /^<\s*\/\s*([A-Za-z][A-Za-z0-9_.:-]*)\s*>$/.exec(token);
        if (closing) {
            const normalizedName = closing[1].toLowerCase();
            const name = TAG_NAMES.get(normalizedName) || normalizedName;
            if (!stack.length || stack[stack.length - 1] !== name) throw fail('SVG tags are not balanced.');
            stack.pop();
            output.push(`</${name}>`);
            if (name === 'svg') rootClosed = true;
            continue;
        }

        const opening = /^<\s*([A-Za-z][A-Za-z0-9_.:-]*)([\s\S]*?)\s*(\/?)>$/.exec(token);
        if (!opening) throw fail('Malformed SVG tag.');
        const normalizedName = opening[1].toLowerCase();
        const name = TAG_NAMES.get(normalizedName) || normalizedName;
        if (!ALLOWED_TAGS.has(normalizedName)) throw fail(`SVG element "${normalizedName}" is not allowed.`);
        if (rootClosed || (name !== 'svg' && !rootSeen)) throw fail('SVG must have one root element.');
        if (name === 'svg' && rootSeen) throw fail('SVG must have one root element.');
        tagCount += 1;
        if (tagCount > 5000) throw fail('SVG contains too many elements.');

        const attributes = parseAttributes(opening[2], name);
        if (name === 'svg') {
            rootSeen = true;
            const xmlns = attributes.find(([key]) => key === 'xmlns');
            if (xmlns && xmlns[1] !== 'http://www.w3.org/2000/svg') throw fail('SVG namespace is invalid.');
            if (!xmlns) attributes.unshift(['xmlns', 'http://www.w3.org/2000/svg']);
        }

        const serialized = attributes
            .map(([key, value]) => `${key}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}` + '"')
            .join(' ');
        output.push(`<${name}${serialized ? ` ${serialized}` : ''}${opening[3] ? ' />' : '>'}`);
        if (!opening[3]) {
            stack.push(name);
            if (stack.length > 100) throw fail('SVG nesting is too deep.');
        }
    }

    if (!rootSeen || !rootClosed || stack.length !== 0) throw fail('SVG must contain a complete <svg> document.');
    const result = output.join('');
    if (Buffer.byteLength(result, 'utf8') > MAX_GENERATED_SVG_BYTES) throw fail('Sanitized SVG is too large.');
    return result;
}
