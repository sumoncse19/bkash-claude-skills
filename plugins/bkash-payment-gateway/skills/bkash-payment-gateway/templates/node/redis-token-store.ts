import crypto from "node:crypto";
import type { TokenState, TokenStore } from "./bkash";

/** Minimal shape of node-redis v4 / ioredis-compatible client used here. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { NX?: boolean; PX?: number }): Promise<string | null>;
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const UNLOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Shares one bKash token across all processes/servers. */
export class RedisTokenStore implements TokenStore {
  constructor(private readonly redis: RedisLike, private readonly key = "bkash:token") {}

  async get(): Promise<TokenState | null> {
    const v = await this.redis.get(this.key);
    return v ? (JSON.parse(v) as TokenState) : null;
  }

  async set(state: TokenState): Promise<void> {
    await this.redis.set(this.key, JSON.stringify(state));
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockKey = `${this.key}:lock`;
    const id = crypto.randomUUID();
    const deadline = Date.now() + 40_000;
    while (!(await this.redis.set(lockKey, id, { NX: true, PX: 35_000 }))) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for bKash token lock");
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      return await fn();
    } finally {
      await this.redis.eval(UNLOCK, { keys: [lockKey], arguments: [id] });
    }
  }
}
