import axios, { AxiosError } from 'axios';
import pdf from 'pdf-parse';
import logger from '../utils/logger';

export interface SafaricomReceipt {
    success: true;
    reference: string;
    receiptNo?: string;
    senderName?: string;
    senderPhone?: string;
    senderTin?: string;
    receiverName?: string;
    receiverPhone?: string;
    paymentMethod?: string;
    transactionType?: string;
    paymentChannel?: string;
    paymentReason?: string | null;
    amount?: number;
    serviceFee?: number;
    vat?: number;
    total?: number;
    amountInWords?: string;
    date?: Date;
    institution?: string;
}

export interface SafaricomFailure {
    success: false;
    error: string;
    responseCode?: string;
}

export type SafaricomVerifyResult = SafaricomReceipt | SafaricomFailure;

const RECEIPT_ENDPOINT = 'https://m-pesabusiness.safaricom.et/api/receipt/getReceipt';
const REFERENCE_RE = /^[A-Z0-9]{6,20}$/;

// Safaricom's edge intermittently drops or hangs connections (even from an
// Ethiopian IP), so the direct fetch is retried a few times before giving up.
const SAFARICOM_RETRY_COUNT = parseInt(process.env.SAFARICOM_RETRY_COUNT || '4', 10);
const SAFARICOM_RETRY_DELAY_MS = parseInt(process.env.SAFARICOM_RETRY_DELAY_MS || '1000', 10);

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SafaricomApiResponse {
    responseCode?: string | number;
    responseDescription?: string;
    base64Data?: string;
}

// Bright Data Web Unlocker path: many hosting providers (Vercel, AWS us-east-1)
// have their egress IPs silently dropped by Safaricom's edge, so a direct fetch
// hangs until the socket times out. When BRIGHT_DATA_UNLOCKER_TOKEN and
// BRIGHT_DATA_UNLOCKER_ZONE are configured (same env vars Telebirr uses), route
// the request through Bright Data's Ethiopian residential IPs instead.
async function fetchViaWebUnlocker(trxNo: string): Promise<SafaricomApiResponse> {
    const token = process.env.BRIGHT_DATA_UNLOCKER_TOKEN!;
    const zone = process.env.BRIGHT_DATA_UNLOCKER_ZONE!;
    const country = process.env.BRIGHT_DATA_UNLOCKER_COUNTRY || 'et';
    const url = `${RECEIPT_ENDPOINT}?trxNo=${encodeURIComponent(trxNo)}`;

    logger.info(`Fetching Safaricom receipt via Bright Data Web Unlocker (country=${country}): ${url}`);
    let response;
    try {
        response = await axios.post(
            'https://api.brightdata.com/request',
            { zone, url, country, format: 'raw' },
            {
                timeout: 25000,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                validateStatus: () => true,
            }
        );
    } catch (err) {
        if (err instanceof AxiosError) {
            throw new Error(`Bright Data request failed: ${err.code || err.message}`);
        }
        throw err;
    }

    // Diagnostic hints from Bright Data: x-brd-error-code / x-luminati-error tell us
    // if the request never made it to Safaricom (proxy-level failure), and
    // x-response-code carries the actual status the target returned.
    const brdError = response.headers['x-brd-error-code'] || response.headers['x-luminati-error'];
    const targetStatus = response.headers['x-response-code'] || response.headers['x-brd-status'];

    if (response.status >= 400 || brdError) {
        const bodyPreview = typeof response.data === 'string'
            ? response.data.slice(0, 200)
            : JSON.stringify(response.data).slice(0, 200);
        throw new Error(
            `Bright Data HTTP ${response.status}${brdError ? ` (brd-error=${brdError})` : ''}` +
            `${targetStatus ? ` (target=${targetStatus})` : ''}: ${bodyPreview || '<empty body>'}`
        );
    }

    const raw = response.data;
    if (typeof raw === 'string' && raw.length === 0) {
        throw new Error(
            `Web Unlocker returned empty body (target=${targetStatus || 'unknown'}` +
            `${brdError ? `, brd-error=${brdError}` : ''})`
        );
    }

    let parsed: unknown = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new Error(`Web Unlocker returned non-JSON body (target=${targetStatus || 'unknown'}): ${raw.slice(0, 200)}`);
        }
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`Web Unlocker returned unexpected body type: ${typeof parsed}`);
    }

    return parsed as SafaricomApiResponse;
}

async function fetchDirectly(trxNo: string): Promise<SafaricomApiResponse> {
    const response = await axios.get(RECEIPT_ENDPOINT, {
        params: { trxNo },
        timeout: 25000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
        },
    });
    return response.data;
}

// Direct fetch is the primary path (no proxy cost). Retried because Safaricom's
// edge drops connections intermittently.
async function fetchDirectlyWithRetry(trxNo: string): Promise<SafaricomApiResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SAFARICOM_RETRY_COUNT; attempt++) {
        try {
            return await fetchDirectly(trxNo);
        } catch (error) {
            lastError = error;
            const detail = error instanceof AxiosError ? (error.code || error.message) : String(error);
            if (attempt < SAFARICOM_RETRY_COUNT) {
                logger.warn(`Safaricom direct attempt ${attempt}/${SAFARICOM_RETRY_COUNT} failed (${detail}). Retrying in ${SAFARICOM_RETRY_DELAY_MS}ms...`);
                await delay(SAFARICOM_RETRY_DELAY_MS);
            } else {
                logger.error(`Safaricom direct attempt ${attempt}/${SAFARICOM_RETRY_COUNT} failed (${detail}).`);
            }
        }
    }
    throw lastError;
}

// Extracts the M-PESA transaction number from a raw SMS. Sent-money SMSes contain
// a receipt URL of the form https://m-pesabusiness.safaricom.et/receipt/<ref>, and
// both sent and received SMSes include "Transaction number [is] <ref>".
export function extractSafaricomReference(text: string): string | null {
    if (!text) return null;
    const urlMatch = text.match(/m-pesabusiness\.safaricom\.et\/receipt\/([A-Z0-9]{6,20})/i);
    if (urlMatch) return urlMatch[1].toUpperCase();
    const inlineMatch = text.match(/Transaction\s+number\s+(?:is\s+)?([A-Z0-9]{6,20})/i);
    if (inlineMatch) return inlineMatch[1].toUpperCase();
    return null;
}

export async function verifySafaricom(reference: string): Promise<SafaricomVerifyResult> {
    const trxNo = (reference || '').trim().toUpperCase();
    if (!REFERENCE_RE.test(trxNo)) {
        return { success: false, error: 'Invalid Safaricom transaction reference format' };
    }

    logger.info(`Starting Safaricom verification for reference: ${trxNo}`);
    const hasUnlocker = Boolean(process.env.BRIGHT_DATA_UNLOCKER_TOKEN && process.env.BRIGHT_DATA_UNLOCKER_ZONE);

    let apiResponse: SafaricomApiResponse | null = null;
    let unlockerError: string | null = null;
    let directError: string | null = null;

    // Step 1: direct fetch (no proxy). Preferred — works when this service runs
    // from an Ethiopian egress IP and costs nothing.
    try {
        apiResponse = await fetchDirectlyWithRetry(trxNo);
    } catch (error) {
        if (error instanceof AxiosError) {
            const status = error.response?.status;
            const detail = error.code || (status ? `HTTP ${status}` : 'network error');
            logger.error(`Direct Safaricom fetch failed (${detail}): ${error.message}`);
            directError = `${detail}${error.message ? ` — ${error.message}` : ''}`;
        } else {
            logger.error('Unexpected error in direct Safaricom fetch:', error);
            directError = error instanceof Error ? error.message : 'unknown error';
        }
    }

    // Step 2: Bright Data Web Unlocker fallback (only when configured).
    if (!apiResponse && hasUnlocker) {
        try {
            logger.warn('Direct Safaricom fetch failed. Trying Bright Data Web Unlocker fallback...');
            apiResponse = await fetchViaWebUnlocker(trxNo);
        } catch (err) {
            unlockerError = err instanceof Error ? err.message : String(err);
            logger.error(`Safaricom Web Unlocker leg failed: ${unlockerError}`);
        }
    }

    if (!apiResponse) {
        const parts: string[] = [];
        if (directError) parts.push(`direct: ${directError}`);
        if (unlockerError) parts.push(`unlocker: ${unlockerError}`);
        return {
            success: false,
            error: `Failed to fetch Safaricom receipt (${parts.join('; ') || 'unknown error'})`,
        };
    }

    const { responseCode, responseDescription, base64Data } = apiResponse;

    if (responseCode !== '0' && responseCode !== 0) {
        return {
            success: false,
            error: responseDescription || 'Safaricom API returned an error',
            responseCode: String(responseCode ?? ''),
        };
    }

    if (typeof base64Data !== 'string' || base64Data.length === 0) {
        return { success: false, error: 'Safaricom API response missing PDF payload' };
    }

    const pdfBuffer = Buffer.from(base64Data, 'base64');
    return parseSafaricomReceipt(pdfBuffer, trxNo);
}

export async function verifySafaricomText(text: string): Promise<SafaricomVerifyResult> {
    const reference = extractSafaricomReference(text);
    if (!reference) {
        return { success: false, error: 'Could not find an M-PESA transaction number in the provided text' };
    }
    return verifySafaricom(reference);
}

// ── PDF text helpers ──
// M-PESA receipts come in (at least) two templates: Send Money (P2P) and B2C
// (bank/business → customer). pdf extraction interleaves Amharic label lines with
// English ones, and the real value is not always the first line after a label —
// these helpers grab the first *real* value and skip Ethiopic-only label lines.

// First line after `labelRe` that looks like a real text value (skips Amharic labels).
function valueAfterLabel(text: string, labelRe: RegExp): string | undefined {
    const m = labelRe.exec(text);
    if (!m) return undefined;
    const after = text.slice(m.index + m[0].length);
    for (const raw of after.split(/\r?\n/)) {
        const t = raw.trim();
        if (!t) continue;
        if (t.startsWith('/')) return undefined; // next field label -> no value
        if (!/[A-Za-z]/.test(t)) continue; // Ethiopic/symbol-only label line
        return t;
    }
    return undefined;
}

// First `123.45` (optionally "Birr") after `labelRe`.
function numberAfterLabel(text: string, labelRe: RegExp): string | undefined {
    const m = labelRe.exec(text);
    if (!m) return undefined;
    const after = text.slice(m.index + m[0].length);
    for (const raw of after.split(/\r?\n/)) {
        const t = raw.trim();
        if (!t) continue;
        const num = t.match(/^([\d,]+\.\d{2})/);
        if (num) return num[1];
        if (t.startsWith('/')) return undefined;
    }
    return undefined;
}

// First phone-looking integer after `labelRe`.
function phoneAfterLabel(text: string, labelRe: RegExp): string | undefined {
    const m = labelRe.exec(text);
    if (!m) return undefined;
    const after = text.slice(m.index + m[0].length);
    for (const raw of after.split(/\r?\n/)) {
        const t = raw.trim();
        if (!t) continue;
        const num = t.match(/^(\d{9,15})/);
        if (num) return num[1];
        if (t.startsWith('/')) return undefined;
    }
    return undefined;
}

// Nearest standalone `123.45 [Birr]` line directly ABOVE `labelRe` (fees sit above labels).
function feeAboveLabel(text: string, labelRe: RegExp): number | undefined {
    const m = labelRe.exec(text);
    if (!m) return undefined;
    const lines = text.slice(0, m.index).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const num = lines[i].match(/^([\d,]+\.\d{2})(?:\s*Birr)?$/);
        if (num) return parseFloat(num[1].replace(/,/g, ''));
    }
    return undefined;
}

async function parseSafaricomReceipt(buffer: Buffer, reference: string): Promise<SafaricomVerifyResult> {
    try {
        const parsed = await pdf(buffer);
        const text = parsed.text;

        const trxIdMatch = text.match(/\/\s*TRANSACTION ID\s*\r?\n([A-Z0-9]+)/i);
        const rowMatch = text.match(/([A-Z0-9]{8,})(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})([\d,]+\.\d{2})/);

        const toNum = (s: string | undefined) => (s ? parseFloat(s.replace(/[^\d.]/g, '')) : undefined);
        const cleanReason = (s: string | undefined) => {
            if (!s) return null;
            const trimmed = s.trim();
            return trimmed && trimmed !== '- - -' ? trimmed : null;
        };

        // Sender: Send Money uses SENDER NAME/PHONE/TIN; B2C (bank → M-PESA) uses PAYER NAME/PHONE/TIN.
        const senderName = valueAfterLabel(text, /\/\s*SENDER NAME\s*\r?\n/i)
            ?? valueAfterLabel(text, /\/\s*PAYER NAME\s*\r?\n/i);
        const senderPhone = phoneAfterLabel(text, /\/\s*SENDER PHONE NUMBER\s*\r?\n/i)
            ?? phoneAfterLabel(text, /\/\s*PAYER PHONE NUMBER\s*\r?\n/i);
        const senderTinRaw = valueAfterLabel(text, /\/\s*SENDER TIN NO\s*\r?\n/i)
            ?? valueAfterLabel(text, /\/\s*PAYER TIN NO\s*\r?\n/i)
            ?? numberAfterLabel(text, /\/\s*SENDER TIN NO\s*\r?\n/i)
            ?? numberAfterLabel(text, /\/\s*PAYER TIN NO\s*\r?\n/i);

        // Receiver name may be separated by an Amharic label line (B2C) — helpers skip it.
        const receiverName = valueAfterLabel(text, /\/\s*RECEIVER NAME\s*\r?\n/i);
        const receiverPhone = text.match(/(\d{9,15})\r?\n\/\s*TRANSACTION ID/i)?.[1];

        const paymentMethod = valueAfterLabel(text, /\/\s*PAYMENT METHOD\s*\r?\n/i);
        const paymentReason = cleanReason(valueAfterLabel(text, /\/\s*PAYMENT REASON\s*\r?\n/i));

        // Type/channel: Send Money has TRANSACTION TYPE + PAYMENT CHANNEL; B2C has only type "B2C Payment".
        const typeChannelMatch = text.match(/\/\s*TRANSACTION TYPE\s*\r?\n\/\s*PAYMENT CHANNEL\s*\r?\n([^\r\n]+)\r?\n([^\r\n]+)/i);
        let transactionType = typeChannelMatch?.[1]?.trim();
        const paymentChannel = typeChannelMatch?.[2]?.trim();
        if (!transactionType && /\bB2C Payment\b/i.test(text)) transactionType = 'B2C Payment';

        const total = toNum(numberAfterLabel(text, /\/\s*TOTAL\s*\r?\n/i));
        const amountInWords = valueAfterLabel(text, /\/\s*TOTAL AMOUNT IN WORDS\s*\r?\n/i)
            ?.replace(/\s+/g, ' ').trim();

        // Fees sit directly ABOVE their labels (never the settled-amount row, which has trailing text).
        const serviceFee = feeAboveLabel(text, /\/\s*SERVICE FEE\s*\r?\n/i);
        const vat = feeAboveLabel(text, /\/\s*\+?\s*15% VAT\s*\r?\n/i);

        const institution = text.match(/[+\d][\d \-]{6,}\r?\n([^\r\n\/]+)\r?\nየላኪ ስም/)?.[1]?.trim()
            ?? text.match(/(Safaricom M-PESA Mobile Financial Services)/i)?.[1];

        const trxId = trxIdMatch?.[1]?.trim() || reference;
        const receiptNo = rowMatch?.[1]?.trim();
        const dateRaw = rowMatch?.[2]?.trim();
        const amount = toNum(rowMatch?.[3]);
        const date = dateRaw ? new Date(dateRaw.replace(' ', 'T')) : undefined;

        const result: SafaricomReceipt = {
            success: true,
            reference: trxId,
            receiptNo,
            senderName,
            senderPhone,
            senderTin: cleanReason(senderTinRaw) || undefined,
            receiverName,
            receiverPhone,
            paymentMethod,
            transactionType,
            paymentChannel,
            paymentReason,
            amount,
            serviceFee,
            vat,
            total: total ?? amount,
            amountInWords,
            date,
            institution,
        };

        if (!result.reference || result.amount === undefined) {
            return { success: false, error: 'Could not extract required fields from Safaricom PDF' };
        }

        return result;
    } catch (err) {
        logger.error('Failed to parse Safaricom receipt PDF:', err);
        return { success: false, error: 'Error parsing Safaricom receipt PDF' };
    }
}
