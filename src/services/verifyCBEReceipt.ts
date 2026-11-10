import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';
import { VerifyResult } from './verifyCBE';

// CBE Mobile Banking sends the sender an SMS such as
//   "Dear X You have successfully transferred ETB 6,700.00 from account 1**4094 to account 1**6877
//    (Hanan W). ... Thanks for Banking with CBE. https://mbreciept.cbe.com.et/v2-hfHCxNWkNAv00rw94H8F"
// The link opens a page that reads the receipt from CBE's public receipt API. We read the same API,
// so no PDF, no browser and no account suffix is needed. The "v2-..." token is issued by CBE; an
// edited or made-up token is rejected by CBE.
const RECEIPT_API = 'https://Mb.cbe.com.et/api/v1/transactions/public/transaction-detail/';
// The two headers the receipt page itself sends (public, they only identify the web app).
const RECEIPT_HEADERS = {
    'X-App-ID': 'd1292e42-7400-49de-a2d3-9731caa4c819',
    'X-App-Version': '0a01980b-9859-1369-8198-59f403820000',
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};
const RETRY_COUNT = parseInt(process.env.CBE_RECEIPT_RETRY_COUNT || '2', 10);
const RETRY_DELAY_MS = parseInt(process.env.CBE_RECEIPT_RETRY_DELAY_MS || '1000', 10);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The "v2-..." receipt token from a pasted SMS or link, or null. Case is kept: the token is case-sensitive. */
export function extractCbeReceiptToken(text: string): string | null {
    if (!text) return null;
    const match = text.match(/mbrec(?:ie|ei)pt\.cbe\.com\.et\/(v\d+-[A-Za-z0-9_-]{8,80})/i);
    return match ? match[1] : null;
}

async function fetchReceipt(token: string): Promise<any> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
        try {
            const response = await axios.get(RECEIPT_API + encodeURIComponent(token), {
                timeout: 15000,
                headers: RECEIPT_HEADERS,
            });
            return response.data;
        } catch (error) {
            lastError = error;
            // A 4xx/5xx answer from CBE (bad or unknown token) will not change on retry.
            if (error instanceof AxiosError && error.response) throw error;
            const detail = error instanceof AxiosError ? (error.code || error.message) : String(error);
            logger.warn(`CBE receipt fetch attempt ${attempt}/${RETRY_COUNT} failed (${detail})`);
            if (attempt < RETRY_COUNT) await delay(RETRY_DELAY_MS);
        }
    }
    throw lastError;
}

export async function verifyCBEReceiptText(text: string): Promise<VerifyResult> {
    const token = extractCbeReceiptToken(text);
    if (!token) return { success: false, error: 'Could not find a CBE receipt link in the provided text' };
    return verifyCBEReceipt(token);
}

export async function verifyCBEReceipt(token: string): Promise<VerifyResult> {
    try {
        logger.info('Starting CBE receipt verification');
        const data = await fetchReceipt(token);

        if (!data || !data.id) return { success: false, error: 'CBE returned no receipt for this link' };
        if (String(data.status || '').toUpperCase() !== 'COMPLETED') {
            return { success: false, error: `CBE transfer is not completed (${data.status || 'unknown status'})` };
        }

        const amount = parseFloat(String(data.amountCredited ?? data.creditAmount ?? '').replace(/,/g, ''));
        const dateValue = Array.isArray(data.dateTimes) && data.dateTimes[0] ? new Date(data.dateTimes[0]) : undefined;
        if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: 'CBE receipt has no valid amount' };

        return {
            success: true,
            payer: data.debitAccountHolder || undefined,
            payerAccount: data.debitAccountNo || undefined,
            receiver: data.creditAccountHolder || undefined,
            receiverAccount: data.creditAccountNo || undefined,
            amount,
            date: dateValue && !Number.isNaN(dateValue.getTime()) ? dateValue : undefined,
            reference: String(data.id),
            reason: data.description || null,
        };
    } catch (error) {
        const status = error instanceof AxiosError ? error.response?.status : undefined;
        logger.error(`CBE receipt verification failed${status ? ` (HTTP ${status})` : ''}`);
        if (status && status >= 400 && status < 500) {
            return { success: false, error: 'CBE did not accept this receipt link' };
        }
        if (status) return { success: false, error: 'CBE could not find a receipt for this link' };
        return { success: false, error: 'CBE receipt service is not reachable right now, try again shortly' };
    }
}
