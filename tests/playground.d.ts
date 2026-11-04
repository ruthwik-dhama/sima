declare module '*/playground/server.mjs' {
  import type { Server } from 'node:http';
  export function startPlayground(port?: number): Promise<Server>;
}
