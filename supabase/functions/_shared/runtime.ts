import { createHandler, type Rpc } from "./handler.ts";

export function serve(kind: "telegram-auth" | "session") {
  const required = (name: string) => {
    const value = Deno.env.get(name);
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const url = required("SUPABASE_URL");
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const rpc: Rpc = async (name, args) => {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Database request failed");
    if (response.status === 204) return null;
    const body = await response.text();
    return body ? JSON.parse(body) : null;
  };
  Deno.serve(
    createHandler(kind, {
      botToken: required("TELEGRAM_BOT_TOKEN"),
      allowedOrigins: required("ALLOWED_ORIGINS")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      rpc,
    }),
  );
}
