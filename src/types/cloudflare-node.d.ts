declare module "cloudflare:node" {
    export interface HttpServerHandlerOptions {
        port: number;
    }

    export function httpServerHandler(
        options: HttpServerHandlerOptions
    ): (request: any, ...args: any[]) => Promise<Response>;

    export function handleAsNodeRequest(
        server: unknown,
        request: unknown
    ): Promise<Response>;
}