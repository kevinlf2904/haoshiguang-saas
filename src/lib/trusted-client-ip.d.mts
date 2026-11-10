export function getTrustedVercelClientIp(headers: {
  get(name: string): string | null;
}): string | null;
