// Minimal ambient declaration for the Workers runtime module. Only `index.ts`
// imports it; the handler receives an injected sender so tests run in Node.
declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: ReadableStream | string);
    readonly from: string;
    readonly to: string;
  }
}
