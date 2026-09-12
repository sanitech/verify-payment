export default async function pdf(): Promise<never> {
    throw new Error("pdf-parse is unavailable on Cloudflare Workers runtime");
}