import { useMemo } from 'react';
import { encode } from 'uqr';
import { Button } from './ui';

/**
 * Local QR for the CIS invoice-check URL. Encoded here so the till still
 * works offline; tapping Open launches the official tax page in the browser.
 */
export function FiscalVerifyQr({
  value,
  caption,
  openLabel,
}: {
  value: string;
  caption: string;
  openLabel: string;
}) {
  const path = useMemo(() => qrModulePath(value), [value]);

  const openOfficial = async () => {
    const opened = await window.api.system
      ?.openExternal?.(value)
      .catch(() => false);
    if (!opened) window.open(value, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-2 rounded-lg border border-black/10 bg-white p-3">
      <svg
        viewBox={`0 0 ${path.size} ${path.size}`}
        width={192}
        height={192}
        className="mx-auto block"
        shapeRendering="crispEdges"
        role="img"
        aria-label={caption}
      >
        <rect width={path.size} height={path.size} fill="#fff" />
        <path fill="#000" d={path.d} />
      </svg>
      <p className="text-center text-[11px] leading-snug text-gray-700">
        {caption}
      </p>
      <Button size="sm" block onClick={() => void openOfficial()}>
        {openLabel}
      </Button>
    </div>
  );
}

export function qrModulePath(value: string): { size: number; d: string } {
  const { data, size } = encode(value, { ecc: 'M', border: 2 });
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = data[y];
    for (let x = 0; x < size; x += 1) {
      if (row[x]) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return { size, d: parts.join('') };
}
