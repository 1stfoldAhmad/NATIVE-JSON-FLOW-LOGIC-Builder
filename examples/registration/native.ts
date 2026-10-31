/**
 * Demo native implementations for the registration example.
 *
 * In a real Expo app these would call the backend through a registered API
 * adapter (fetch / tRPC / etc.). Natives are the ONLY place where I/O is
 * allowed — JSON definitions can never perform it directly.
 */

import type { LogicEngine } from "../../src/index.ts";

export interface DemoUser {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  roles: string[];
}

export interface DemoDb {
  users: Map<string, DemoUser>;
  notifications: Array<{ userId: string; email: string; at: number }>;
}

export function createDemoDb(): DemoDb {
  return { users: new Map(), notifications: [] };
}

export function registerDemoNatives(engine: LogicEngine, db: DemoDb): void {
  // Natives declare the capabilities they are granted; the engine checks them
  // against the function definitions' required capabilities before every call.
  engine.registerNative(
    "userApi.findByEmail",
    async (args) => {
      return db.users.get(String(args.email)) ?? null;
    },
    { capabilities: ["api.read"] },
  );

  engine.registerNative(
    "userApi.createUser",
    async (args) => {
      const email = String(args.email);
      if (db.users.has(email)) {
        throw new Error("duplicate");
      }
      const user: DemoUser = {
        id: `user-${db.users.size + 1}`,
        name: String(args.name),
        email,
        // NOTE: real apps hash passwords on the backend only — never on the frontend.
        passwordHash: `demo-hash:${String(args.password).length}`,
        roles: ["user"],
      };
      db.users.set(email, user);
      return user;
    },
    { capabilities: ["api.write"] },
  );

  engine.registerNative(
    "notification.sendVerification",
    async (args) => {
      db.notifications.push({
        userId: String(args.userId),
        email: String(args.email),
        at: Date.now(),
      });
      return { sent: true };
    },
    { capabilities: ["notification.send"] },
  );
}
