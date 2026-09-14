import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('lucideIcons subset', () => {
  it('re-exports per-icon modules instead of the lucide-react barrel', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/lucideIcons.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"]lucide-react['"]/);
    const files = [
      ...src.matchAll(/from 'lucide-react\/dist\/esm\/icons\/([^']+)'/g),
    ].map((m) => m[1]);
    expect(files.length).toBeGreaterThanOrEqual(50);
    for (const file of files) {
      expect(
        existsSync(
          resolve(
            process.cwd(),
            'node_modules/lucide-react/dist/esm/icons',
            file,
          ),
        ),
        file,
      ).toBe(true);
    }
  });
});
