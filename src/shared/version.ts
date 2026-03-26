import fs from 'node:fs';
import path from 'node:path';

const __sharedDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));

export const CODEGRAPH_VERSION: string = (
  JSON.parse(fs.readFileSync(path.join(__sharedDir, '..', '..', 'package.json'), 'utf-8')) as {
    version: string;
  }
).version;
