// Same-origin API helper. Local API authorization is injected by the desktop
// shell and is never exposed to renderer JavaScript.
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, init);
}

export interface Me {
  user: { id: number; email: string; name: string | null; role: "admin" | "member" };
  household: { id: string; name: string | null; base_currency?: string };
}

export async function getMe(): Promise<Me | null> {
  const res = await fetch("/api/me");
  if (!res.ok) throw new Error("Failed to load identity");
  return res.json();
}
