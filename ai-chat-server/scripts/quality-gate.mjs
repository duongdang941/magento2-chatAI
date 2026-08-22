import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const gatewayRoot = resolve(new URL('..', import.meta.url).pathname);
const moduleRoot = resolve(gatewayRoot, '..');
const repositoryRoot = resolve(moduleRoot, '../../../..');
const phpBinary = process.env.PHP_BIN || 'php';

async function collectFiles(directory, predicate, files = []) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (['node_modules', 'vendor', '.ua'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collectFiles(path, predicate, files);
        else if (entry.isFile() && predicate(path)) files.push(path);
    }
    return files.sort();
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    return result.status === 0;
}

const testFiles = await collectFiles(join(gatewayRoot, 'test'), path => path.endsWith('.test.js'));
const checks = [];
checks.push(['Node test suite', run(process.execPath, ['--test', ...testFiles], gatewayRoot)]);

const phpFiles = await collectFiles(moduleRoot, path => path.endsWith('.php'));
let phpLintPassed = true;
for (const file of phpFiles) {
    if (!run('php', ['-l', file], moduleRoot)) phpLintPassed = false;
}
checks.push([`PHP syntax (${phpFiles.length} files)`, phpLintPassed]);
const phpUnit = join(repositoryRoot, 'vendor/bin/phpunit');
checks.push(['PHPUnit module suite', run(phpUnit, ['--bootstrap', join(repositoryRoot, 'vendor/autoload.php'), join(moduleRoot, 'Test/Unit')], repositoryRoot)]);

const productionPhpFiles = phpFiles.filter(path => !path.includes('/Test/'));
const phpcs = join(repositoryRoot, 'vendor/bin/phpcs');
checks.push([
    `Magento coding standard (${productionPhpFiles.length} production PHP files)`,
    existsSync(phpcs) && run(phpBinary, [phpcs, '-n', '--standard=Magento2', ...productionPhpFiles], repositoryRoot)
]);

const phpstan = join(repositoryRoot, 'vendor/bin/phpstan');
checks.push([
    'PHPStan static analysis',
    existsSync(phpstan) && run(phpBinary, [phpstan, 'analyse', moduleRoot, '--no-progress'], repositoryRoot)
]);

const failed = checks.filter(([, passed]) => !passed);
console.log(JSON.stringify({
    ok: failed.length === 0,
    checks: checks.map(([name, passed]) => ({ name, passed })),
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
