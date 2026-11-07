import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TranslationCache } from '../lib/translation-cache.js';

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), '31-palabras-test-')), 'data', 'translations.json');

test('translations survive a restart', () => {
  const file = tempFile();
  new TranslationCache(file).set('hola', 'hello');
  assert.equal(new TranslationCache(file).get('hola'), 'hello');
  assert.equal(new TranslationCache(file).get('constructor'), undefined);
});

test('a damaged file is ignored rather than stopping the app', (t) => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  t.mock.method(console, 'warn', () => {});
  const cache = new TranslationCache(file);
  assert.equal(cache.get('hola'), undefined);
  cache.set('hola', 'hello');
  assert.equal(new TranslationCache(file).get('hola'), 'hello');
});
