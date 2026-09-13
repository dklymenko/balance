// The local app has no login identity or shared household, but the client
// renders a profile name in Settings and the reset-confirmation dialog. One
// fixed name keeps that UI stable: /api/me serves it and
// POST /api/data/reset expects it as the confirmation echo.
export const LOCAL_HOUSEHOLD_NAME = "Balance";
