declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env> {
    protected env: Env;
  }
}
