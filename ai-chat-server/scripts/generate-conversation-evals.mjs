#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { conversationScenarios } from '../evals/conversation-scenarios.mjs';

const destination = resolve(process.cwd(), 'test/fixtures/commerce-conversation-scenarios.json');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(conversationScenarios, null, 2)}\n`, 'utf8');

console.log(`Generated ${conversationScenarios.length} multi-turn conversation scenarios at ${destination}`);
