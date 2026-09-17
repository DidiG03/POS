import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('waiter haptics', () => {
  it('does not buzz every button; only opt-in controls and outcome toasts', () => {
    const haptics = read('src/renderer/utils/haptics.ts');
    expect(haptics).toContain('[data-haptic]:not([data-haptic="off"])');
    expect(haptics).not.toContain("addEventListener('touchstart'");

    const toasts = read('src/renderer/stores/toasts.ts');
    expect(toasts).toContain("t.level === 'success'");
    expect(toasts).toContain("t.level === 'warn'");
    expect(toasts).toContain("t.level === 'error'");
    expect(toasts).not.toMatch(/t\.level === 'info'[\s\S]{0,80}hapticForToast/);

    const floor = read('src/renderer/app/components/FloorCanvas.tsx');
    expect(floor).not.toContain('data-haptic');
  });
});
