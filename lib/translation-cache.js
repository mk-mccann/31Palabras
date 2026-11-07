// Keeps paid-for translations across restarts, so the same line never spends the
// DeepL allowance twice. It can always be rebuilt, so a damaged file only costs
// a warning.

import fs from 'node:fs';
import path from 'node:path';

export class TranslationCache {
  constructor(file) {
    this.file = file;
    this.entries = {};
    try {
      this.entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`Ignoring saved translations in ${file}: ${err.message}`);
    }
  }

  get(key) {
    return Object.hasOwn(this.entries, key) ? this.entries[key] : undefined;
  }

  set(key, value) {
    this.entries[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.entries));
    fs.renameSync(temp, this.file);
  }
}
