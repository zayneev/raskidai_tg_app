const EXPECTED_BACKEND_VERSION = "8";

type Check = {
  name: string;
  path: string;
  init: RequestInit;
  status: number;
};

export async function smokeCheck(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  expectedVersion = EXPECTED_BACKEND_VERSION,
) {
  const base = baseUrl.replace(/\/$/, "");
  const checks: Check[] = [
    {
      name: "session rejects missing authorization",
      path: "/functions/v1/session",
      init: { method: "GET" },
      status: 401,
    },
    {
      name: "events rejects missing authorization",
      path: "/functions/v1/events",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      },
      status: 401,
    },
    {
      name: "telegram auth rejects invalid initData",
      path: "/functions/v1/telegram-auth",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: "invalid" }),
      },
      status: 401,
    },
    {
      name: "telegram auth rejects malformed JSON",
      path: "/functions/v1/telegram-auth",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      },
      status: 400,
    },
  ];
  const results = [];
  for (const check of checks) {
    const response = await fetcher(`${base}${check.path}`, check.init);
    const version = response.headers.get("x-raskidai-backend-version");
    if (response.status !== check.status) {
      throw new Error(
        `${check.name}: expected HTTP ${check.status}, got ${response.status}`,
      );
    }
    if (version !== expectedVersion) {
      throw new Error(
        `${check.name}: expected backend ${expectedVersion}, got ${version ?? "missing"}`,
      );
    }
    results.push({ name: check.name, status: response.status, version });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.argv[2] ?? process.env.VITE_SUPABASE_URL;
  if (!baseUrl) {
    console.error("Usage: pnpm smoke -- https://PROJECT_REF.supabase.co");
    process.exitCode = 2;
  } else {
    smokeCheck(baseUrl).then(
      (results) => {
        for (const result of results) {
          console.log(
            `ok - ${result.name} (HTTP ${result.status}, backend ${result.version})`,
          );
        }
      },
      (error: unknown) => {
        console.error(
          error instanceof Error ? error.message : "Smoke check failed",
        );
        process.exitCode = 1;
      },
    );
  }
}
