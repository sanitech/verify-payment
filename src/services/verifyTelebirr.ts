import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";
import puppeteer, { Browser } from "puppeteer-core";
import logger from '../utils/logger';

/** Thrown when the Telebirr proxy returns 502/503/504 (gateway timeout or unavailable). */
export class TelebirrProxyTimeoutError extends Error {
    readonly statusCode = 504;
    readonly code = 'PROXY_TIMEOUT';
    constructor(message: string = 'Verification service timed out. Please try again.') {
        super(message);
        this.name = 'TelebirrProxyTimeoutError';
    }
}

// Keep retries very small in production to avoid long request times on Render/other hosts.
// Can still be overridden via VERIFY_RETRY_COUNT / VERIFY_RETRY_DELAY_MS env vars if needed.
const VERIFY_RETRY_COUNT = parseInt(process.env.VERIFY_RETRY_COUNT || "2", 10);
const VERIFY_RETRY_DELAY_MS = parseInt(process.env.VERIFY_RETRY_DELAY_MS || "1500", 10);

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Puppeteer shared browser singleton (lazy-init, reused across requests) ──

import { execSync } from "child_process";

let sharedBrowser: Browser | null = null;

function findChromiumPath(): string | undefined {
    // 1. Explicit env var takes priority
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

    // 2. Try common paths
    const candidates = [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
    ];
    for (const p of candidates) {
        try { require("fs").accessSync(p); return p; } catch {}
    }

    // 3. Try `which chromium`
    try {
        return execSync("which chromium 2>/dev/null || which chromium-browser 2>/dev/null", { encoding: "utf-8" }).trim();
    } catch {}

    return undefined;
}

async function getBrowser(): Promise<Browser> {
    if (sharedBrowser && sharedBrowser.connected) {
        return sharedBrowser;
    }

    const executablePath = findChromiumPath();
    logger.info("Launching shared Puppeteer browser instance...", { executablePath: executablePath || "(default)" });

    sharedBrowser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--ignore-certificate-errors",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
        ],
        executablePath,
    });

    sharedBrowser.on("disconnected", () => {
        logger.warn("Puppeteer browser disconnected, will re-launch on next request.");
        sharedBrowser = null;
    });

    return sharedBrowser;
}

export async function cleanupBrowser(): Promise<void> {
    if (sharedBrowser) {
        try {
            await sharedBrowser.close();
        } catch { /* ignore */ }
        sharedBrowser = null;
    }
}

export interface TelebirrReceipt {
    payerName: string;
    payerTelebirrNo: string;
    creditedPartyName: string;
    creditedPartyAccountNo: string;
    transactionStatus: string;
    receiptNo: string;
    paymentDate: string;
    settledAmount: string;
    serviceFee: string;
    serviceFeeVAT: string;
    totalPaidAmount: string;
    bankName: string;
}

/**
 * Enhanced regex-based extractor for settled amount - multiple patterns like PHP version
 * @param htmlContent The raw HTML content
 * @returns Extracted settled amount or null
 */
function extractSettledAmountRegex(htmlContent: string): string | null {
    // Pattern 1: Direct match with the exact text structure
    const pattern1 = /የተከፈለው\s+መጠን\/Settled\s+Amount.*?<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d{2})?\s+Birr)/is;
    let match = htmlContent.match(pattern1);
    if (match) return match[1].replace(/,/g, '').trim();

    // Pattern 2: Look for the table row structure
    const pattern2 = /<tr[^>]*>.*?የተከፈለው\s+መጠን\/Settled\s+Amount.*?<td[^>]*>\s*([\d,]+(?:\.\d{2})?\s+Birr)/is;
    match = htmlContent.match(pattern2);
    if (match) return match[1].replace(/,/g, '').trim();

    // Pattern 3: More flexible approach - look for any cell containing "Settled Amount" followed by amount
    // Only match within the same table row (<tr>) to avoid matching service fee row
    const pattern3 = /Settled\s+Amount[\s\S]*?<td[^>]*>\s*([\d,]+(?:\.\d{2})?\s+Birr)/is;
    match = htmlContent.match(pattern3);
    if (match) return match[1].replace(/,/g, '').trim();

    // Pattern 4: Look specifically in the transaction details table
    const pattern4 = /የክፍያ\s+ዝርዝር\/Transaction\s+details[\s\S]*?<tr[^>]*>[\s\S]*?<td[^>]*>\s*[^<]*<\/td>\s*<td[^>]*>\s*[^<]*<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d{2})?\s+Birr)/is;
    match = htmlContent.match(pattern4);
    if (match) return match[1].replace(/,/g, '').trim();

    return null;
}

/**
 * Enhanced regex-based extractor for service fee
 * @param htmlContent The raw HTML content
 * @returns Extracted service fee or null
 */
function extractServiceFeeRegex(htmlContent: string): string | null {
    // Pattern to match "የአገልግሎት ክፍያ/Service fee" followed by amount in Birr
    // Make sure we don't match VAT version
    const pattern = /የአገልግሎት\s+ክፍያ\/Service\s+fee(?!\s+ተ\.እ\.ታ).*?<\/td>\s*<td[^>]*>\s*(\d+(?:\.\d{2})?\s+Birr)/i;
    const match = htmlContent.match(pattern);
    if (match) return match[1].trim();

    return null;
}

/**
 * Enhanced regex-based extractor for receipt number
 * @param htmlContent The raw HTML content
 * @returns Extracted receipt number or null
 */
function extractReceiptNoRegex(htmlContent: string): string | null {
    // Extract receipt number from the transaction details table
    const pattern = /<td[^>]*class="[^"]*receipttableTd[^"]*receipttableTd2[^"]*"[^>]*>\s*([A-Z0-9]+)\s*<\/td>/i;
    const match = htmlContent.match(pattern);
    if (match) return match[1].trim();

    return null;
}

/**
 * Enhanced regex-based extractor for payment date
 * @param htmlContent The raw HTML content
 * @returns Extracted payment date or null
 */
function extractDateRegex(htmlContent: string): string | null {
    // Extract date in format DD-MM-YYYY HH:MM:SS
    const pattern = /(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/;
    const match = htmlContent.match(pattern);
    if (match) return match[1].trim();

    return null;
}

/**
 * Generic regex extractor for other fields
 * @param htmlContent The raw HTML content
 * @param labelPattern The label to search for
 * @param valuePattern The pattern for the value (defaults to capturing any non-tag content)
 * @returns Extracted value or null
 */
function extractWithRegex(htmlContent: string, labelPattern: string, valuePattern: string = '([^<]+)'): string | null {
    // Escape special regex characters in the label pattern
    const escapedLabel = labelPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedLabel}.*?<\\/td>\\s*<td[^>]*>\\s*${valuePattern}`, 'i');
    const match = htmlContent.match(pattern);
    if (match) return match[1].replace(/<[^>]*>/g, '').trim(); // Strip any remaining HTML tags

    return null;
}

/**
 * Regex-based extractor for settled amount and service fee as fallback
 * @param htmlContent The raw HTML content
 * @returns Object containing extracted values
 */
function extractWithRegexLegacy(htmlContent: string): { settledAmount: string | null; serviceFee: string | null } {
    // Use the new enhanced extractors
    const settledAmount = extractSettledAmountRegex(htmlContent);
    const serviceFee = extractServiceFeeRegex(htmlContent);

    return {
        settledAmount,
        serviceFee
    };
}

/**
 * Scrapes Telebirr receipt data from HTML content
 * @param html The HTML content to scrape
 * @returns Extracted Telebirr receipt data
 */
function scrapeTelebirrReceipt(html: string): TelebirrReceipt {
    const $ = cheerio.load(html);

    // Log HTML content in debug mode to help diagnose scraping issues
    logger.debug(`HTML content length: ${html.length} bytes`);
    if (html.length < 100) {
        logger.warn(`Suspiciously short HTML response: ${html}`);
    }

    const getText = (selector: string): string =>
        $(selector).next().text().trim();

    const getPaymentDate = (): string => {
        // First try regex extraction
        const regexDate = extractDateRegex(html);
        if (regexDate) return regexDate;

        // Fallback to cheerio
        return $('.receipttableTd').filter((_, el) => $(el).text().includes("-202")).first().text().trim();
    };

    const getReceiptNo = (): string => {
        // First try regex extraction
        const regexReceiptNo = extractReceiptNoRegex(html);
        if (regexReceiptNo) return regexReceiptNo;

        // Fallback to cheerio
        return $('td.receipttableTd.receipttableTd2')
            .eq(1) // second match: the value, not the label
            .text()
            .trim();
    };

    const getSettledAmount = (): string => {
        // First try the enhanced regex approach
        const regexAmount = extractSettledAmountRegex(html);
        if (regexAmount) return regexAmount;

        // Fallback to cheerio approach
        let amount = $('td.receipttableTd.receipttableTd2')
            .filter((_, el) => {
                const prevTd = $(el).prev();
                return prevTd.text().includes("የተከፈለው መጠን") || prevTd.text().includes("Settled Amount");
            })
            .text()
            .trim();

        // If that doesn't work, try looking in the transaction details table
        if (!amount) {
            amount = $('tr')
                .filter((_, el) => {
                    return $(el).find('td').first().text().includes("የተከፈለው መጠን") ||
                        $(el).find('td').first().text().includes("Settled Amount");
                })
                .find('td')
                .last()
                .text()
                .trim();
        }

        return amount;
    };

    const getServiceFee = (): string => {
        // First try the enhanced regex approach
        const regexFee = extractServiceFeeRegex(html);
        if (regexFee) return regexFee;

        // Fallback to cheerio approach - look for service fee but not service fee VAT
        let fee = $('td.receipttableTd1')
            .filter((_, el) => {
                const text = $(el).text();
                return (text.includes("የአገልግሎት ክፍያ") || text.includes("Service fee")) &&
                    !text.includes("ተ.እ.ታ") && !text.includes("VAT");
            })
            .next('td.receipttableTd.receipttableTd2')
            .text()
            .trim();

        // Alternative approach - look in table rows
        if (!fee) {
            fee = $('tr')
                .filter((_, el) => {
                    const text = $(el).text();
                    return (text.includes("የአገልግሎት ክፍያ") || text.includes("Service fee")) &&
                        !text.includes("ተ.እ.ታ") && !text.includes("VAT");
                })
                .find('td')
                .last()
                .text()
                .trim();
        }

        return fee;
    };

    // Helper function to extract text using regex first, then cheerio
    const getTextWithFallback = (labelText: string, cheerioSelector?: string): string => {
        // Try regex first
        const regexResult = extractWithRegex(html, labelText);
        if (regexResult) return regexResult;

        // Fallback to cheerio if selector provided
        if (cheerioSelector) {
            return getText(cheerioSelector);
        }

        // Default cheerio approach
        return getText(`td:contains("${labelText}")`);
    };

    logger.debug("SERVICE FEE: ", getServiceFee());
    logger.debug("SETTLED AMOUNT: ", getSettledAmount());

    // Get regex results as backup for debugging
    const regexResults = extractWithRegexLegacy(html);
    logger.debug("Regex results:", regexResults);

    let creditedPartyName = getTextWithFallback("የገንዘብ ተቀባይ ስም/Credited Party name");
    let creditedPartyAccountNo = getTextWithFallback("የገንዘብ ተቀባይ ቴሌብር ቁ./Credited party account no");
    let bankName = "";

    const bankAccountNumberRaw = getTextWithFallback("የባንክ አካውንት ቁጥር/Bank account number");

    if (bankAccountNumberRaw) {
        bankName = creditedPartyName; // The original credited party name is the bank
        const bankAccountRegex = /(\d+)\s+(.*)/;
        const match = bankAccountNumberRaw.match(bankAccountRegex);
        if (match) {
            creditedPartyAccountNo = match[1].trim();
            creditedPartyName = match[2].trim();
        }
    }


    return {
        payerName: getTextWithFallback("የከፋይ ስም/Payer Name"),
        payerTelebirrNo: getTextWithFallback("የከፋይ ቴሌብር ቁ./Payer telebirr no."),
        creditedPartyName,
        creditedPartyAccountNo,
        transactionStatus: getTextWithFallback("የክፍያው ሁኔታ/transaction status"),
        receiptNo: getReceiptNo(),
        paymentDate: getPaymentDate(),
        settledAmount: getSettledAmount(),
        serviceFee: getServiceFee(),
        serviceFeeVAT: getTextWithFallback("የአገልግሎት ክፍያ ተ.እ.ታ/Service fee VAT"),
        totalPaidAmount: getTextWithFallback("ጠቅላላ የተከፈለ/Total Paid Amount"),
        bankName
    };
}

/**
 * Parses Telebirr receipt data from JSON response
 * @param jsonData The JSON data from the proxy endpoint
 * @returns Extracted Telebirr receipt data
 */
function parseTelebirrJson(jsonData: any): TelebirrReceipt | null {
    try {
        // Check if the response has the expected structure
        if (!jsonData || !jsonData.success || !jsonData.data) {
            logger.warn("Invalid JSON structure from proxy endpoint", { jsonData });
            return null;
        }

        const data = jsonData.data;

        return {
            payerName: data.payerName || "",
            payerTelebirrNo: data.payerTelebirrNo || "",
            creditedPartyName: data.creditedPartyName || "",
            creditedPartyAccountNo: data.creditedPartyAccountNo || "",
            transactionStatus: data.transactionStatus || "",
            receiptNo: data.receiptNo || "",
            paymentDate: data.paymentDate || "",
            settledAmount: data.settledAmount || "",
            serviceFee: data.serviceFee || "",
            serviceFeeVAT: data.serviceFeeVAT || "",
            totalPaidAmount: data.totalPaidAmount || "",
            bankName: data.bankName || ""
        };
    } catch (error) {
        logger.error("Error parsing JSON from proxy endpoint", { error, jsonData });
        return null;
    }
}

/**
 * Fetches and processes Telebirr receipt data from the primary source (HTML)
 * @param reference The Telebirr reference number
 * @param baseUrl The base URL to fetch the receipt from
 * @returns The scraped receipt data or null if failed
 */
async function fetchFromPrimarySource(reference: string, baseUrl: string): Promise<TelebirrReceipt | null> {
    const url = `${baseUrl}${reference}`;

    try {
        logger.info(`Attempting to fetch Telebirr receipt from primary source: ${url}`);
        const response = await axios.get(url, { timeout: 60000 }); // 60 second timeout
        logger.debug(`Received response with status: ${response.status}`);

        const extractedData = scrapeTelebirrReceipt(response.data);

        logger.debug("Extracted data from HTML:", extractedData);
        logger.info(`Successfully extracted Telebirr data for reference: ${reference}`, {
            receiptNo: extractedData.receiptNo,
            payerName: extractedData.payerName,
            transactionStatus: extractedData.transactionStatus,
            settledAmount: extractedData.settledAmount,
            serviceFee: extractedData.serviceFee
        });

        return extractedData;
    } catch (error) {
        // Enhanced error logging with request details
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const errorStack = error instanceof Error ? error.stack : undefined;

        // Check if it's an Axios error to safely access response properties
        const axiosError = error as AxiosError;
        const responseDetails = axiosError.response ? {
            status: axiosError.response.status,
            statusText: axiosError.response.statusText,
            responseData: axiosError.response.data
        } : {};

        logger.error(`Error fetching Telebirr receipt from primary source ${url}:`, {
            error: errorMessage,
            stack: errorStack,
            ...responseDetails
        });

        return null;
    }
}

/**
 * Fetches Telebirr receipt HTML via Puppeteer (headless browser) then scrapes it.
 * Uses the shared browser singleton and blocks images/CSS/fonts for speed.
 */
async function fetchFromPuppeteer(reference: string, baseUrl: string): Promise<TelebirrReceipt | null> {
    const url = `${baseUrl}${reference}`;
    let page;
    try {
        logger.info(`Attempting to fetch Telebirr receipt via Puppeteer: ${url}`);
        const browser = await getBrowser();
        page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on("request", (req) => {
            const resourceType = req.resourceType();
            if (["image", "stylesheet", "font", "media"].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        const html = await page.content();
        logger.debug(`Puppeteer received ${html.length} bytes of HTML for reference: ${reference}`);

        const extractedData = scrapeTelebirrReceipt(html);

        logger.info(`Puppeteer extracted Telebirr data for reference: ${reference}`, {
            receiptNo: extractedData.receiptNo,
            payerName: extractedData.payerName,
            transactionStatus: extractedData.transactionStatus,
        });

        return extractedData;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        logger.error(`Puppeteer fetch failed for reference ${reference}:`, { error: errorMessage });
        return null;
    } finally {
        if (page) {
            try { await page.close(); } catch { /* ignore */ }
        }
    }
}

/**
 * Fetches and processes Telebirr receipt data from the fallback proxy (JSON)
 * @param reference The Telebirr reference number
 * @param proxyUrl The proxy URL to fetch the receipt from
 * @returns The parsed receipt data or null if failed
 */
async function fetchFromProxySource(reference: string, proxyUrl: string): Promise<TelebirrReceipt | null> {
    const url = proxyUrl;

    try {
        logger.info(`Attempting to fetch Telebirr receipt from proxy: ${url}`);
        const response = await axios.post(
            url,
            { reference },
            {
                timeout: 60000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'VerifierAPI/1.0',
                    'Content-Type': 'application/json'
                }
            }
        );

        logger.debug(`Received proxy response with status: ${response.status}`);

        // Check if response is JSON
        let data = response.data;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                logger.warn("Proxy response is not valid JSON, attempting to scrape as HTML");
                // If it's not JSON, try to scrape it as HTML
                return scrapeTelebirrReceipt(response.data);
            }
        }

        const extractedData = parseTelebirrJson(data);
        if (!extractedData) {
            logger.warn("Failed to parse JSON from proxy, attempting to scrape as HTML");
            // If JSON parsing fails, try to scrape it as HTML
            return scrapeTelebirrReceipt(response.data);
        }

        logger.debug("Extracted data from JSON:", extractedData);
        logger.info(`Successfully extracted Telebirr data from proxy for reference: ${reference}`, {
            receiptNo: extractedData.receiptNo,
            payerName: extractedData.payerName,
            transactionStatus: extractedData.transactionStatus
        });

        return extractedData;
    } catch (error) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;

        // Surface proxy gateway timeouts so the API can return 504 and a clear message.
        if (status === 502 || status === 503 || status === 504) {
            logger.warn(`Telebirr proxy returned ${status} (Gateway Timeout/Unavailable): ${url}`);
            throw new TelebirrProxyTimeoutError(
                'Verification service temporarily unavailable (timeout). Please try again in a moment.'
            );
        }

        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const errorStack = error instanceof Error ? error.stack : undefined;
        const responseDetails = axiosError.response ? {
            status: axiosError.response.status,
            statusText: axiosError.response.statusText,
            responseData: axiosError.response.data
        } : {};

        logger.error(`Error fetching Telebirr receipt from proxy ${url}:`, {
            error: errorMessage,
            stack: errorStack,
            ...responseDetails
        });

        return null;
    }
}

async function attemptFetch(
    fetcher: (reference: string, url: string) => Promise<TelebirrReceipt | null>,
    reference: string,
    url: string,
    label: string
): Promise<TelebirrReceipt | null> {
    for (let attempt = 1; attempt <= VERIFY_RETRY_COUNT; attempt++) {
        const result = await fetcher(reference, url);
        if (result && isValidReceipt(result)) {
            return result;
        }

        if (attempt < VERIFY_RETRY_COUNT) {
            logger.warn(`${label} attempt ${attempt} failed for reference ${reference}. Retrying in ${VERIFY_RETRY_DELAY_MS}ms...`);
            await delay(VERIFY_RETRY_DELAY_MS);
        }
    }

    return null;
}

export async function verifyTelebirr(reference: string): Promise<TelebirrReceipt | null> {
    const primaryUrl = "https://transactioninfo.ethiotelecom.et/receipt/";
    const fallbackUrl =
        process.env.TELEBIRR_FALLBACK_URL ||
        "https://payment-verify.pinael.com/verify-telebirr";

    const skipPrimary = process.env.SKIP_PRIMARY_VERIFICATION === "true";

    // Step 1: Direct axios fetch
    if (!skipPrimary) {
        const primaryResult = await attemptFetch(fetchFromPrimarySource, reference, primaryUrl, "primary source");
        if (primaryResult && isValidReceipt(primaryResult)) return primaryResult;
        logger.warn(`Primary Telebirr verification failed for reference: ${reference}. Trying Puppeteer...`);
    } else {
        logger.info(`Skipping primary verifier due to SKIP_PRIMARY_VERIFICATION=true`);
    }

    // Step 2: Puppeteer fallback (shared browser, blocked resources)
    const puppeteerResult = await attemptFetch(fetchFromPuppeteer, reference, primaryUrl, "puppeteer");
    if (puppeteerResult && isValidReceipt(puppeteerResult)) {
        logger.info(`Successfully verified Telebirr receipt via Puppeteer for reference: ${reference}`);
        return puppeteerResult;
    }
    logger.warn(`Puppeteer verification failed for reference: ${reference}. Trying fallback proxy...`);

    // Step 3: Fallback proxy
    const fallbackResult = await attemptFetch(fetchFromProxySource, reference, fallbackUrl, "fallback proxy");
    if (fallbackResult && isValidReceipt(fallbackResult)) {
        logger.info(`Successfully verified Telebirr receipt using fallback proxy for reference: ${reference}`);
        return fallbackResult;
    }

    logger.error(`All Telebirr verification methods failed for reference: ${reference}`);
    return null;
}

// Add this helper function to validate receipt data
function isValidReceipt(receipt: TelebirrReceipt): boolean {
    // Check if essential fields have values
    return Boolean(
        receipt.receiptNo &&
        receipt.payerName &&
        receipt.transactionStatus
    );
}
