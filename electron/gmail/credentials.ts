import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Gmail OAuth 자격증명 폴더 — oauth-client.json·token.json을 읽기만 한다(token.json은 따로 발급해 둔다) */
const CRED_DIR = path.join(os.homedir(), '.template-builder', 'gmail-credentials');

export class CredError extends Error {
  readonly code = 'credentials-missing' as const;
  constructor(message: string) {
    super(message);
  }
}

export interface GmailCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUri: string;
  accessToken?: string;
  expiryDate?: number;
  scope?: string;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new CredError(
      `자격증명 파일을 읽을 수 없습니다: ${file}\nGmail OAuth 자격증명(oauth-client.json·token.json)을 먼저 준비하세요.`,
    );
  }
}

/** oauth-client.json(installed|web) + token.json 읽어 자격증명 구성. token.json은 절대 쓰지 않음. */
export async function loadGmailCreds(): Promise<GmailCreds> {
  const clientRaw = await readJson(path.join(CRED_DIR, 'oauth-client.json'));
  const tokenRaw = await readJson(path.join(CRED_DIR, 'token.json'));

  const c = (clientRaw.installed ?? clientRaw.web ?? clientRaw) as Record<string, unknown>;
  const clientId = c.client_id as string | undefined;
  const clientSecret = c.client_secret as string | undefined;
  const tokenUri =
    (c.token_uri as string | undefined) ??
    (tokenRaw.token_uri as string | undefined) ??
    'https://oauth2.googleapis.com/token';
  const refreshToken = tokenRaw.refresh_token as string | undefined;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new CredError('자격증명 필드 누락 (client_id/client_secret/refresh_token).');
  }
  return {
    clientId,
    clientSecret,
    refreshToken,
    tokenUri,
    accessToken: tokenRaw.access_token as string | undefined,
    expiryDate: tokenRaw.expiry_date as number | undefined,
    scope: tokenRaw.scope as string | undefined,
  };
}

/** drafts.create는 gmail.modify/compose/full 스코프로 가능 */
export function hasGmailDraftScope(scope?: string): boolean {
  if (!scope) return true; // 스코프 정보 없으면 시도 (REST가 권한 오류로 알려줌)
  return (
    scope.includes('gmail.modify') ||
    scope.includes('gmail.compose') ||
    scope.includes('https://mail.google.com/')
  );
}
