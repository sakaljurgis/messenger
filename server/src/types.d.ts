import type { UserRow } from './db/schema.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by sessionMiddleware when a valid session cookie is present. */
      user?: UserRow;
      /** Set by the bot-api auth middleware when a valid `Bearer <apiToken>` is present. */
      bot?: UserRow;
    }
  }
}

export {};
