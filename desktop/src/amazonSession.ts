interface CookieStore {
  flushStore(): Promise<void>;
}

interface FlushableSession {
  cookies: CookieStore;
}

interface ClearableSession {
  closeAllConnections(): Promise<void>;
  clearAuthCache(): Promise<void>;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
}

// Chromium batches cookie writes. Flush before closing the Amazon window so a
// newly completed sign-in is available on the next Balance launch.
export async function flushAmazonSignIn(target: FlushableSession): Promise<void> {
  await target.cookies.flushStore();
}

// Forget the whole isolated browser profile, not a hand-picked cookie list.
// Amazon can move authentication state between cookies and site storage over
// time; clearing every storage type avoids leaving a partial live session.
export async function forgetAmazonSignIn(target: ClearableSession): Promise<void> {
  await target.closeAllConnections();
  await target.clearAuthCache();
  await target.clearStorageData();
  await target.clearCache();
}
