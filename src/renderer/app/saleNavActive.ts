function pathMatches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Tables/sale tab. `/app/orders` must not count as `/app/order`. */
export function isSaleNavActive(pathname: string, hasTables: boolean): boolean {
  const saleTo = hasTables ? '/app/tables' : '/app/order';
  return (
    pathMatches(pathname, saleTo) ||
    (hasTables && pathMatches(pathname, '/app/order'))
  );
}
