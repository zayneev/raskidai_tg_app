// The launch parameter is a capability, never proof of user identity. The server
// hashes it and checks the invitation and the authenticated session together.
export function launchInvitation(
  initData: string,
  search: string,
): string | null {
  const value =
    new URLSearchParams(initData).get("start_param") ??
    new URLSearchParams(search).get("tgWebAppStartParam");
  return value?.match(/^invite_([a-f0-9]{64})$/)?.[1] ?? null;
}
export function invitationLink(token: string): string {
  return `https://t.me/raskidai_app_bot?startapp=invite_${token}`;
}
