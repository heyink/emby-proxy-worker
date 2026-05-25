export interface Target {
  scheme: string;
  domain: string;
  port: number;
  path: string;
  query: string;
}

export interface Env {
  WEBSOCKET_PROXY: DurableObjectNamespace;
  ALLOWED_DOMAINS?: string;
  REWRITE_BASE_URL?: string;
  SECRET_PREFIX?: string;
}
