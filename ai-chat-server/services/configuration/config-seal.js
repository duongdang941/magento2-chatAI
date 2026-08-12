import crypto from 'node:crypto';

const VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const AAD = Buffer.from('afd-ai-runtime-config-v1', 'utf8');

function encryptionSecret(secret) {
    const value = String(secret || process.env.AI_CONFIG_ENCRYPTION_KEY || process.env.AI_NODE_SYNC_SECRET || '');
    if (value.length < 32) {
        throw new Error('AI_CONFIG_ENCRYPTION_KEY or AI_NODE_SYNC_SECRET must contain at least 32 characters.');
    }
    return value;
}

function encryptionKey(secret) {
    return crypto.createHash('sha256').update(encryptionSecret(secret), 'utf8').digest();
}

export function isSealedConfig(value) {
    return value?.sealed_version === VERSION
        && value?.algorithm === ALGORITHM
        && typeof value?.ciphertext === 'string';
}

export function sealConfig(config, secret = '') {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(secret), nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(config), 'utf8'),
        cipher.final()
    ]);

    return {
        sealed_version: VERSION,
        algorithm: ALGORITHM,
        nonce: nonce.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url')
    };
}

export function unsealConfig(value, secret = '') {
    if (!isSealedConfig(value)) return value;

    try {
        const decipher = crypto.createDecipheriv(
            ALGORITHM,
            encryptionKey(secret),
            Buffer.from(value.nonce, 'base64url')
        );
        decipher.setAAD(AAD);
        decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(value.ciphertext, 'base64url')),
            decipher.final()
        ]).toString('utf8');
        return JSON.parse(plaintext);
    } catch {
        throw new Error('The stored AI configuration could not be authenticated or decrypted.');
    }
}
