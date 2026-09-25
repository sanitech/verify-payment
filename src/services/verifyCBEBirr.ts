import axios from 'axios';
import pdfParse from 'pdf-parse';
import { VerifyResult } from './verifyCBE';
import logger from '../utils/logger';

export interface CBEBirrReceipt {
  customerName: string;
  debitAccount: string;
  creditAccount: string;
  receiverName: string;
  orderId: string;
  transactionStatus: string;
  reference: string;
  receiptNumber: string;
  transactionDate: string;
  amount: string;
  paidAmount: string;
  serviceCharge: string;
  vat: string;
  totalPaidAmount: string;
  paymentReason: string;
  paymentChannel: string;
}

export { parseCBEBirrReceipt };

export async function verifyCBEBirr(
  receiptNumber: string,
  phoneNumber: string
): Promise<CBEBirrReceipt | { success: false; error: string }> {
  try {
    logger.info(`[CBEBirr] Starting verification for receipt: ${receiptNumber}, phone: ${phoneNumber}`);
    
    // Construct the CBE Birr URL
    const url = `https://cbepay1.cbe.com.et/aureceipt?TID=${receiptNumber}&PH=${phoneNumber}`;
    logger.info(`[CBEBirr] Fetching PDF from: ${url}`);

    // Fetch the PDF
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 30000
    });

    logger.info(`[CBEBirr] PDF response status: ${response.status}`);
    logger.info(`[CBEBirr] PDF content length: ${response.data.length} bytes`);

    if (response.status !== 200) {
      logger.error(`[CBEBirr] Failed to fetch PDF: HTTP ${response.status}`);
      return { success: false, error: `Failed to fetch receipt: HTTP ${response.status}` };
    }

    // Parse the PDF
    const pdfBuffer = Buffer.from(response.data);
    const pdfData = await pdfParse(pdfBuffer);
    const pdfText = pdfData.text;

    logger.info(`[CBEBirr] PDF text extracted (${pdfText.length} characters)`);
    logger.info('[CBEBirr] PDF content preview:', pdfText.substring(0, 1000));
    logger.info('[CBEBirr] Full PDF text content:');
    logger.info(pdfText);

    // Parse the receipt data
    const receiptData = parseCBEBirrReceipt(pdfText);
    
    if (!receiptData) {
      logger.error('[CBEBirr] Failed to parse receipt data from PDF');
      return { success: false, error: 'Failed to parse receipt data from PDF' };
    }

    logger.info('[CBEBirr] Successfully parsed receipt data:', receiptData);
    return receiptData;

  } catch (error) {
    logger.error('[CBEBirr] Error during verification:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error occurred' 
    };
  }
}

function parseCBEBirrReceipt(pdfText: string): CBEBirrReceipt | null {
  try {
    logger.info('[CBEBirr] Starting PDF text parsing (structured parser)...');
    logger.info('[CBEBirr] Full PDF text for debugging:', pdfText);

    const lines = pdfText.split(/\r?\n/).map((l) => l.trimEnd());

    const receiptData = parseStructuredCBEBirr(lines, pdfText);

    if (receiptData.creditAccount || receiptData.receiptNumber || receiptData.amount) {
      logger.info('[CBEBirr] Structured parse produced:', receiptData);
      return receiptData;
    }

    logger.warn('[CBEBirr] Structured parse found no essential fields, trying regex fallback');
    const legacy = parseLegacyRegexCBEBirr(pdfText);
    if (legacy.creditAccount || legacy.receiptNumber || legacy.amount) {
      logger.info('[CBEBirr] Regex fallback parse produced:', legacy);
      return legacy;
    }

    logger.warn('[CBEBirr] No essential fields found in PDF');
    return null;

  } catch (error) {
    logger.error('[CBEBirr] Error parsing PDF text:', error);
    return null;
  }
}

function emptyReceipt(): CBEBirrReceipt {
  return {
    customerName: '',
    debitAccount: '',
    creditAccount: '',
    receiverName: '',
    orderId: '',
    transactionStatus: '',
    reference: '',
    receiptNumber: '',
    transactionDate: '',
    amount: '',
    paidAmount: '',
    serviceCharge: '0.00',
    vat: '0.00',
    totalPaidAmount: '',
    paymentReason: '',
    paymentChannel: '',
  };
}

// Section-aware parser tuned to the actual CBE Birr "VAT Invoice/ Customer Receipt"
// layout. The pdf-parse text has these quirks:
//   - labels are concatenated to their values with no whitespace:
//       "Credit Account0976765611 - ASENAFI BREZABEH MAMO"
//   - long values wrap onto the following line:
//       "Credit Account0976765611 - ASENAFI BREZABEH \nMAMO"
//   - the "Transaction Details" table columns are concatenated:
//       "DIP41PM7JLY2026-09-25 16:3920.00"   (16:39 + 20.00 merge)
function parseStructuredCBEBirr(lines: string[], pdfText: string): CBEBirrReceipt {
  const r = emptyReceipt();

  // ---- Customer Information section ----
  // Layout renders the label block first ("Customer Name:/Region:/City:/Sub city:")
  // and the actual name on its own following line:
  //   Customer Name:
  //   Region:
  //   City:
  //   Sub city:
  //   ASENAFI BREZABEH MAMO
  //   Wereda/kebele:
  const custStart = lines.findIndex((l) => /^Customer Name:/i.test(l.trim()));
  if (custStart !== -1) {
    for (let i = custStart + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^Wereda\/kebele:/i.test(t)) break;
      if (!t) continue;
      if (/^Region:/i.test(t) || /^City:/i.test(t) || /^Sub city:/i.test(t) || /^Branch:/i.test(t)) continue;
      if (/^[A-Z][A-Z .'()-]{2,}$/.test(t) && !/^[A-Z]+:$/.test(t)) {
        r.customerName = t;
        break;
      }
    }
  }

  // ---- Transaction Information section ----
  // Labels and values are adjacent on the same line; values may wrap to the next
  // line. Lookahead terminates at the next label or the "Transaction Details" header.
  const txnLabels: Array<[keyof CBEBirrReceipt, RegExp]> = [
    ['debitAccount', /^Debit Account\s*/i],
    ['creditAccount', /^Credit Account\s*/i],
    ['receiverName', /^Receiver Name\s*/i],
    ['orderId', /^Order ID\s*/i],
    ['transactionStatus', /^Transaction Status\s*/i],
    ['reference', /^Reference\s*/i],
  ];
  const txnInfoIdx = lines.findIndex((l) => /^Transaction Information/i.test(l.trim()));
  if (txnInfoIdx !== -1) {
    const isLabelOrHeader = (t: string) =>
      t !== '' && (txnLabels.some(([, re]) => re.test(t)) || /^Transaction Details/i.test(t));
    for (let i = txnInfoIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^Transaction Details/i.test(t)) break;
      const hit = txnLabels.find(([, re]) => re.test(t));
      if (!hit) continue;
      const [key, re] = hit;
      let value = t.replace(re, '');
      for (let j = i + 1; j < lines.length; j++) {
        const nxt = lines[j].trim();
        if (isLabelOrHeader(nxt)) break;
        value = value ? `${value} ${nxt}` : nxt;
      }
      r[key] = value.trim();
    }
  }

  // ---- Transaction Details table ----
  const detailsIdx = lines.findIndex((l) => /^Receipt Number/i.test(l.trim()));
  if (detailsIdx !== -1) {
    const body = lines.slice(detailsIdx + 1);
    const dataIdx = body.findIndex((l) => l.trim() !== '');
    if (dataIdx !== -1) {
      const row = body[dataIdx].replace(/\s+/g, ' ').trim();
      const dateMatch = row.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
      if (dateMatch) {
        r.receiptNumber = row.slice(0, dateMatch.index).trim();
        r.transactionDate = dateMatch[1].replace(/\s+/g, ' ');
        const after = row.slice(dateMatch.index! + dateMatch[1].length).trim();
        const amountMatch = after.match(/([\d,]+\.\d{2})/);
        if (amountMatch) r.amount = amountMatch[1];
      }
    }

    // Financial rows appear as standalone numbers below the data row:
    //   Paid amount, Service Charge, VAT, Total Paid Amount
    const belowNumbers: string[] = [];
    for (let i = detailsIdx + 1 + (dataIdx >= 0 ? dataIdx + 1 : 0); i < lines.length; i++) {
      const m = lines[i].match(/([\d,]+\.\d{2})/g);
      if (m) belowNumbers.push(...m);
    }
    const [paid = '', service = '0.00', vat = '0.00', totalPaid = ''] = belowNumbers;
    r.paidAmount = r.amount || paid;
    r.serviceCharge = service;
    r.vat = vat;
    r.totalPaidAmount = totalPaid || r.amount;
    if (!r.amount && paid) r.amount = paid;
  }

  // ---- Payment details (bottom section) ----
  const bottomIdx = lines.findIndex((l) => /^Total Amount in word/i.test(l.trim()));
  if (bottomIdx !== -1) {
    const seq = lines
      .slice(bottomIdx + 1)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !/^The Bank/i.test(l) && !/^©/i.test(l) && !/all rights reserved/i.test(l));
    const wordsIdx = seq.findIndex((l) => /Cents|only|ETB|Birr/i.test(l));
    if (wordsIdx !== -1 && seq[wordsIdx + 1]) r.paymentReason = seq[wordsIdx + 1];
    if (wordsIdx !== -1 && seq[wordsIdx + 2]) r.paymentChannel = seq[wordsIdx + 2];
  }

  return r;
}

// Fallback regex parser for older / alternate CBE Birr receipt layouts.
function parseLegacyRegexCBEBirr(pdfText: string): CBEBirrReceipt {
  const r = emptyReceipt();
  const extractValue = (pattern: RegExp): string => {
    const match = pdfText.match(pattern);
    return match && match[1] ? match[1].trim() : '';
  };

  r.customerName = extractValue(/Customer Name:\s*([^\n\r]+?)(?=\s*Region:)/i);
  r.creditAccount = extractValue(/Credit Account[\s\n\r]+([^\n\r]+?)(?=\s*Receiver Name)/i);
  r.receiverName = extractValue(/Receiver Name[\s\n\r]+([^\n\r]+?)(?=\s*Order ID)/i);
  r.orderId = extractValue(/Order ID[\s\n\r]+([A-Z0-9]+)/i) || extractValue(/(FT\d+[A-Z0-9]*)/i);
  r.transactionStatus = extractValue(/Transaction Status[\s\n\r]+([^\n\r]+?)(?=\s*Reference)/i);
  r.reference = extractValue(/Reference[\s\n\r]+([^\n\r]+?)(?=\s*Receipt Number)/i) || r.orderId;
  r.receiptNumber = extractValue(/((?:CGU|DIP|FT)[A-Z0-9]+)/i);
  r.transactionDate = extractValue(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);
  r.amount = extractValue(/([\d,]+\.\d{2})/i);
  r.paidAmount = extractValue(/Paid amount[\s\n\r]*([\d,]+\.\d{2})/i) || r.amount;
  r.serviceCharge = extractValue(/Service Charge[\s\n\r]*([\d,]+\.\d{2})/i) || '0.00';
  r.vat = extractValue(/VAT[\s\n\r]*([\d,]+\.\d{2})/i) || '0.00';
  r.totalPaidAmount = extractValue(/Total Paid Amount[\s\n\r]*([\d,]+\.\d{2})/i) || r.amount;
  r.paymentReason = extractValue(/Payment Reason[\s\n\r]+([^\n\r]+)/i);
  r.paymentChannel = extractValue(/Payment Channel[\s\n\r]+([^\n\r]+)/i);

  return r;
}
