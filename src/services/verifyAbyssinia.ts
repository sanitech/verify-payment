import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';
import { VerifyResult } from './verifyCBE';

function parseTrxId(trx: string): string {
    const len = trx.length;
    const firstHalf = trx.substring(0, len / 2 - 2);
    return trx.substring(len / 2 + 3) === firstHalf
        ? trx.substring(0, len / 2 + 3)
        : trx;
}

const ABYSSINIA_RETRY_COUNT = parseInt(process.env.ABYSSINIA_RETRY_COUNT || '3', 10);
const ABYSSINIA_RETRY_DELAY_MS = parseInt(process.env.ABYSSINIA_RETRY_DELAY_MS || '1500', 10);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Pulls the slip reference out of a pasted SMS / slip link, e.g.
// https://cs.bankofabyssinia.com/slip/?trx=FT26289Q36HJ31164 (the cs/?trx=DFT... feedback link is ignored).
export function extractAbyssiniaReference(text: string): string | null {
    if (!text) return null;
    const slip = text.match(/bankofabyssinia\.com\/slip\/?[^\s]*[?&](?:trx|id)=([A-Z0-9]{8,30})/i);
    if (slip) return slip[1].toUpperCase();
    const bare = text.trim().match(/^(FT[A-Z0-9]{8,28})$/i);
    return bare ? bare[1].toUpperCase() : null;
}

// The SMS id is the 12-char bank reference followed by 5 extra digits; the slip API may expect either form.
function candidateIds(reference: string): string[] {
    const id = reference.trim().toUpperCase();
    const ids = [parseTrxId(id)];
    if (/^FT[A-Z0-9]{10}\d{5}$/.test(id)) ids.push(id.slice(0, 12));
    return [...new Set(ids)];
}

async function fetchSlip(trxId: string): Promise<any> {
    const apiUrl = `https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id=${encodeURIComponent(trxId)}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= ABYSSINIA_RETRY_COUNT; attempt++) {
        try {
            const response = await axios.get(apiUrl, {
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });
            return response.data;
        } catch (error) {
            lastError = error;
            const detail = error instanceof AxiosError ? (error.code || error.message) : String(error);
            logger.warn(`Abyssinia fetch ${trxId} attempt ${attempt}/${ABYSSINIA_RETRY_COUNT} failed (${detail})`);
            if (attempt < ABYSSINIA_RETRY_COUNT) await delay(ABYSSINIA_RETRY_DELAY_MS);
        }
    }
    throw lastError;
}

export async function verifyAbyssiniaText(text: string): Promise<VerifyResult> {
    const reference = extractAbyssiniaReference(text);
    if (!reference) {
        return { success: false, error: 'Could not find a Bank of Abyssinia slip reference in the provided text' };
    }
    return verifyAbyssinia(reference);
}

export async function verifyAbyssinia(reference: string): Promise<VerifyResult> {
    try {
        logger.info(`Starting Abyssinia verification for reference: ${reference}`);

        let jsonData: any;
        let fetchError: unknown;
        for (const trxId of candidateIds(reference)) {
            try {
                jsonData = await fetchSlip(trxId);
                if (jsonData?.header?.status === 'success' && Array.isArray(jsonData.body) && jsonData.body.length > 0) break;
            } catch (error) {
                fetchError = error;
            }
        }
        if (jsonData === undefined && fetchError) {
            const code = fetchError instanceof AxiosError ? (fetchError.code || fetchError.message) : String(fetchError);
            logger.error(`Abyssinia slip API unreachable for ${reference}: ${code}`);
            return { success: false, error: `Bank of Abyssinia receipt service is not responding (${code}). Please try again shortly.` };
        }

        if (!jsonData || !jsonData.header || !jsonData.body || !Array.isArray(jsonData.body)) {
            return { success: false, error: 'Invalid response structure from Abyssinia API' };
        }

        if (jsonData.header.status !== 'success') {
            return { success: false, error: `API returned error status: ${jsonData.header.status}` };
        }

        if (jsonData.body.length === 0) {
            return { success: false, error: 'No transaction data found in response body' };
        }

        const t = jsonData.body[0];

        const amountStr = t['Transferred Amount'] || '';
        const amount = amountStr ? parseFloat(amountStr.replace(/[^\d.]/g, '')) : undefined;
        const dateStr = t['Transaction Date'] || '';
        const date = dateStr ? new Date(dateStr) : undefined;

        const result: VerifyResult = {
            success: true,
            payer: t["Payer's Name"] || t['Source Account Name'] || undefined,
            payerAccount: t['Source Account'] || undefined,
            receiver: t["Receiver's Name"] || undefined,
            receiverAccount: t["Receiver's Account"] || undefined,
            amount,
            date,
            reference: t['Transaction Reference'] || undefined,
            reason: t['Narrative'] || null
        };

        if (!result.reference || !result.amount) {
            return { success: false, error: 'Missing essential fields in transaction data' };
        }

        return result;

    } catch (error) {
        if (error instanceof AxiosError) {
            logger.error(`HTTP Error fetching Abyssinia receipt: ${error.message}`);
        } else {
            logger.error(`Unexpected error in verifyAbyssinia:`, error);
        }
        return { success: false, error: 'Failed to verify Abyssinia transaction' };
    }
}
