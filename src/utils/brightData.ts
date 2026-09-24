import axios, { AxiosProxyConfig } from "axios";
import logger from './logger';

// ── Bright Data proxy (datacenter/ISP/residential) ──
// Built lazily at call time so host env vars are loaded before use.
// All driver verifiers (non-Telebirr) route through this so requests exit
// from a known Bright Data peer instead of the serverless egress IP.
export function buildBrightDataProxy(): AxiosProxyConfig | undefined {
    const fullUrl = process.env.BRIGHT_DATA_URL;
    if (fullUrl) {
        try {
            const u = new URL(fullUrl);
            if (!u.username || !u.password) {
                logger.warn("BRIGHT_DATA_URL is missing username/password. Bright Data proxy disabled.");
                return undefined;
            }
            return {
                protocol: u.protocol.replace(":", "") || "http",
                host: u.hostname,
                port: parseInt(u.port || "22225", 10),
                auth: {
                    username: decodeURIComponent(u.username),
                    password: decodeURIComponent(u.password),
                },
            };
        } catch (err) {
            logger.warn("Invalid BRIGHT_DATA_URL. Bright Data proxy disabled.", err);
            return undefined;
        }
    }

    const host = process.env.BRIGHT_DATA_HOST;
    const port = parseInt(process.env.BRIGHT_DATA_PORT || "22225", 10);
    let username = process.env.BRIGHT_DATA_USERNAME;
    const password = process.env.BRIGHT_DATA_PASSWORD;

    if (!host || !username || !password) {
        return undefined;
    }

    // Country targeting keys the request to a specific geography (e.g. ET for
    // Telebirr). For banks that accept foreign IPs, leave BRIGHT_DATA_COUNTRY
    // unset so the zone's default peer is used.
    const country = (process.env.BRIGHT_DATA_COUNTRY || "").trim();
    if (country && !username.includes("-country-")) {
        username = `${username}-country-${country}`;
    }

    // Optional sticky session to avoid rotating mid-verification.
    const session = (process.env.BRIGHT_DATA_SESSION || "").trim();
    if (session && !username.includes("-session-")) {
        username = `${username}-session-${session}`;
    }

    return { protocol: "http", host, port, auth: { username, password } };
}