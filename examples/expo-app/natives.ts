/**
 * Native implementations for the Expo demo app.
 *
 * Natives are the ONLY I/O extension point: JSON definitions can never perform
 * I/O directly, they call these registered implementations. In production the
 * userApi.* natives call the real backend over fetch/tRPC; here they hit a
 * configurable API base URL so the app runs against any backend (or the stub
 * below when no backend is configured).
 */

import type { LogicEngine } from "vds-json-logic";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE) {
    throw new Error(
      "EXPO_PUBLIC_API_BASE is not set — the demo cannot reach a backend. " +
        "Set it in .env (see README) or rely on the form.submit demo payload.",
    );
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
}

export function registerAppNatives(engine: LogicEngine): void {
  // Capabilities are granted by the native registration; the engine checks them
  // against each function definition's execution.capabilities before every call.
  engine.registerNative(
    "userApi.findByEmail",
    async (args) => {
      try {
        return await api<ApiUser | null>(`/users/by-email?email=${encodeURIComponent(String(args.email))}`);
      } catch {
        return null; // not found / offline -> treated as "no existing user"
      }
    },
    { capabilities: ["api.read"] },
  );

  engine.registerNative(
    "userApi.createUser",
    async (args) => {
      // The backend is authoritative: it hashes the password and assigns roles.
      return await api<ApiUser>("/users", {
        method: "POST",
        body: JSON.stringify({ name: args.name, email: args.email, password: args.password }),
      });
    },
    { capabilities: ["api.write"] },
  );

  engine.registerNative(
    "notification.sendVerification",
    async (args) => {
      await api("/notifications/verification", {
        method: "POST",
        body: JSON.stringify({ userId: args.userId, email: args.email }),
      });
      return { sent: true };
    },
    { capabilities: ["notification.send"] },
  );
}
