export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';

export async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(API_URL + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'include',
  });
  return res.json();
}

export function getSession() {
  return apiFetch('/api/auth/session');
}

export function getLeagues(): Promise<any[]> {
  return apiFetch('/api/leagues');
}

export function createLeague(name: string, format: string, maxManagers: number) {
  return apiFetch('/api/leagues', {
    method: 'POST',
    body: JSON.stringify({ name, format, maxManagers }),
  });
}

export function joinLeague(inviteCode: string) {
  return apiFetch('/api/leagues/join', {
    method: 'POST',
    body: JSON.stringify({ inviteCode }),
  });
}

export function getAssets(assetType?: string, season?: number) {
  const params = new URLSearchParams();
  if (assetType) params.set('assetType', assetType);
  if (season)    params.set('season', String(season));
  const query = params.toString();
  return apiFetch(`/api/assets${query ? `?${query}` : ''}`);
}

export function startDraft(leagueId: string) {
  return apiFetch('/api/draft', {
    method: 'POST',
    body: JSON.stringify({ leagueId }),
  });
}

export function getDraft(leagueId: string) {
  return apiFetch(`/api/draft/${leagueId}`);
}

export function makePick(leagueId: string, assetId: string) {
  return apiFetch('/api/draft/pick', {
    method: 'POST',
    body: JSON.stringify({ leagueId, assetId }),
  });
}
