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

export async function verifyAbyssinia(reference: string): Promise<VerifyResult> {
    try {
        const trxId = parseTrxId(reference);
        logger.info(`Starting Abyssinia verification for reference: ${reference}`);

        const apiUrl = `https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id=${trxId}`;

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

        const jsonData = response.data;

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
