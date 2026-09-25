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

    if (response.status >= 400) {
        const bodyPreview = typeof response.data === 'string'
            ? response.data.slice(0, 200)
            : JSON.stringify(response.data).slice(0, 200);
        throw new Error(`Bright Data HTTP ${response.status}: ${bodyPreview}`);
    }

    let parsed: unknown = response.data;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            const preview = parsed.slice(0, 200);
            throw new Error(`Web Unlocker returned non-JSON body: ${preview}`);
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

    if (hasUnlocker) {
        try {
            apiResponse = await fetchViaWebUnlocker(trxNo);
        } catch (err) {
            unlockerError = err instanceof Error ? err.message : String(err);
            logger.error(`Safaricom Web Unlocker leg failed: ${unlockerError}`);
        }
    } else {
        unlockerError = 'not configured (BRIGHT_DATA_UNLOCKER_TOKEN / BRIGHT_DATA_UNLOCKER_ZONE missing)';
    }

    if (!apiResponse) {
        try {
            apiResponse = await fetchDirectly(trxNo);
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
    }

    if (!apiResponse) {
        const parts: string[] = [];
        if (unlockerError) parts.push(`unlocker: ${unlockerError}`);
        if (directError) parts.push(`direct: ${directError}`);
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

async function parseSafaricomReceipt(buffer: Buffer, reference: string): Promise<SafaricomVerifyResult> {
    try {
        const parsed = await pdf(buffer);
        const text = parsed.text;

        const trxIdMatch = text.match(/\/\s*TRANSACTION ID\s*\r?\n([A-Z0-9]+)/i);
        const rowMatch = text.match(/([A-Z0-9]{8,})(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})([\d,]+\.\d{2})/);
        const senderNameMatch = text.match(/\/\s*SENDER NAME\s*\r?\n([^\r\n]+)/i);
        const senderPhoneMatch = text.match(/\/\s*SENDER PHONE NUMBER\s*\r?\n(\d+)/i);
        const senderTinMatch = text.match(/\/\s*SENDER TIN NO\s*\r?\n([^\r\n]+)/i);
        const receiverNameMatch = text.match(/\/\s*RECEIVER NAME\s*\r?\n([^\r\n]+)/i);
        const receiverPhoneMatch = text.match(/(\d{9,15})\r?\n\/\s*TRANSACTION ID/i);
        const paymentMethodMatch = text.match(/\/\s*PAYMENT METHOD\s*\r?\n([^\r\n]+)/i);
        const typeChannelMatch = text.match(/\/\s*TRANSACTION TYPE\s*\r?\n\/\s*PAYMENT CHANNEL\s*\r?\n([^\r\n]+)\r?\n([^\r\n]+)/i);
        const paymentReasonMatch = text.match(/\/\s*PAYMENT REASON\s*\r?\n([^\r\n]+)/i);
        const totalMatch = text.match(/\/\s*TOTAL\s*\r?\n([\d,]+\.\d{2})/i);
        const wordsMatch = text.match(/\/\s*TOTAL AMOUNT IN WORDS\s*\r?\n([\s\S]+?)\r?\n\s*\/\s*TOTAL/i);
        const feeVatMatch = text.match(/([\d,]+\.\d{2})\s*Birr\s*\r?\n([\d,]+\.\d{2})\s*Birr\s*\r?\n\s*\/\s*SERVICE FEE/i);
        const institutionMatch = text.match(/[+\d][\d \-]{6,}\r?\n([^\r\n\/]+)\r?\nየላኪ ስም/);

        const toNum = (s: string | undefined) => (s ? parseFloat(s.replace(/,/g, '')) : undefined);
        const cleanReason = (s: string | undefined) => {
            if (!s) return null;
            const trimmed = s.trim();
            return trimmed && trimmed !== '- - -' ? trimmed : null;
        };

        const trxId = trxIdMatch?.[1]?.trim() || reference;
        const receiptNo = rowMatch?.[1]?.trim();
        const dateRaw = rowMatch?.[2]?.trim();
        const amount = toNum(rowMatch?.[3]);
        const date = dateRaw ? new Date(dateRaw.replace(' ', 'T')) : undefined;

        const result: SafaricomReceipt = {
            success: true,
            reference: trxId,
            receiptNo,
            senderName: senderNameMatch?.[1]?.trim(),
            senderPhone: senderPhoneMatch?.[1]?.trim(),
            senderTin: cleanReason(senderTinMatch?.[1]) || undefined,
            receiverName: receiverNameMatch?.[1]?.trim(),
            receiverPhone: receiverPhoneMatch?.[1]?.trim(),
            paymentMethod: paymentMethodMatch?.[1]?.trim(),
            transactionType: typeChannelMatch?.[1]?.trim(),
            paymentChannel: typeChannelMatch?.[2]?.trim(),
            paymentReason: cleanReason(paymentReasonMatch?.[1]),
            amount,
            serviceFee: toNum(feeVatMatch?.[1]),
            vat: toNum(feeVatMatch?.[2]),
            total: toNum(totalMatch?.[1]) ?? amount,
            amountInWords: wordsMatch?.[1]?.replace(/\s+/g, ' ').trim(),
            date,
            institution: institutionMatch?.[1]?.trim(),
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
