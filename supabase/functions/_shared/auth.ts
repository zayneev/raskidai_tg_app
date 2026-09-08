const encoder = new TextEncoder();
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function validateInitData(
  raw: unknown,
  botToken: string,
  now = Date.now(),
) {
  const invalid = () => new HttpError(401, "invalid_init_data");
  if (typeof raw !== "string" || !raw || raw.length > 16384) throw invalid();
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw invalid();
  const hash = params.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/.test(hash)) throw invalid();
  params.delete("hash");
  params.sort();
  const check = [...params].map(([key, value]) => `${key}=${value}`).join("\n");
  const seed = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign(
    "HMAC",
    seed,
    encoder.encode(botToken),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = Uint8Array.from(hash.match(/../g)!, (byte) =>
    parseInt(byte, 16),
  );
  if (
    !(await crypto.subtle.verify("HMAC", key, signature, encoder.encode(check)))
  )
    throw invalid();
  const authDate = params.get("auth_date") ?? "";
  if (!/^\d+$/.test(authDate)) throw invalid();
  const age = Math.floor(now / 1000) - Number(authDate);
  if (!Number.isSafeInteger(Number(authDate)) || age < -30 || age > 300) {
    throw new HttpError(401, "expired_init_data");
  }
  let user;
  try {
    user = JSON.parse(params.get("user") ?? "null");
  } catch {
    throw invalid();
  }
  if (
    !user ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    user.is_bot === true ||
    typeof user.first_name !== "string" ||
    !user.first_name.trim() ||
    (user.last_name !== undefined && typeof user.last_name !== "string")
  )
    throw invalid();
  const displayName = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (displayName.length > 256) throw invalid();
  return { telegramId: user.id as number, displayName };
}
export function newSessionToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}
export function bearerToken(request: Request): string {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) throw new HttpError(401, "unauthorized");
  return match[1];
}
