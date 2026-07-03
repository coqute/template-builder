import type { GmailCreds } from './credentials';

export class OAuthError extends Error {
  readonly code: 'refresh-failed' | 'network';
  constructor(code: 'refresh-failed' | 'network', message: string) {
    super(message);
    this.code = code;
  }
}

// access token 메모리 캐시 (token.json은 절대 쓰지 않음 — 발급 도구가 파일 소유)
let cached: { value: string; exp: number } | null = null;

/**
 * access token 획득. token.json의 access_token이 유효하면 재사용,
 * 아니면 refresh_token으로 갱신(메모리에만 저장). forceRefresh로 강제 갱신(401 대응).
 */
export async function getAccessToken(creds: GmailCreds, forceRefresh = false): Promise<string> {
  const now = Date.now();
  const margin = 60_000;

  if (!forceRefresh) {
    if (cached && cached.exp > now + margin) return cached.value;
    if (creds.accessToken && creds.expiryDate && creds.expiryDate > now + margin) {
      cached = { value: creds.accessToken, exp: creds.expiryDate };
      return creds.accessToken;
    }
  }

  let res: Response;
  try {
    res = await fetch(creds.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch {
    throw new OAuthError('network', '토큰 갱신 네트워크 오류');
  }
  if (!res.ok) {
    throw new OAuthError('refresh-failed', `토큰 갱신 실패 (${res.status}) — 자격증명을 다시 발급해야 합니다.`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new OAuthError('refresh-failed', '토큰 응답에 access_token 없음');
  }
  cached = { value: json.access_token, exp: now + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}
