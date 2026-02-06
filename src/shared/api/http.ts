export async function readJsonOrText(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function responseErrorMessage(res: Response, data: unknown): string {
  const obj = data as any;
  return (obj && (obj.message || obj.error)) || res.statusText;
}

