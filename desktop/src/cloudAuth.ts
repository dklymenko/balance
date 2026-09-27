// A stored token is useful during normal startup, but an explicit Sign In
// action follows an auth_required response from the sync engine. In that path
// the stored token has already been rejected and must never short-circuit the
// browser flow.
export function shouldReuseSyncToken(
  token: string | null,
  serverReady: boolean,
  forceFresh: boolean,
): token is string {
  return !forceFresh && serverReady && !!token;
}

export function protocolClientArgs(
  defaultApp: boolean,
  executable: string,
  appEntry: string | undefined,
): { executable: string | undefined; args: string[] | undefined } {
  if (!defaultApp) return { executable: undefined, args: undefined };
  return { executable, args: appEntry ? [appEntry] : [] };
}
