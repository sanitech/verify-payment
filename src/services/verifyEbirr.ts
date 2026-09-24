import axios from "axios";
import * as cheerio from "cheerio";

export type EbirrWallet = "kaafimf" | "coopay";

export interface EbirrReceipt {
  transactionId: string;
  wallet: EbirrWallet;
  senderName: string;
  senderAccount: string;
  receiverName: string;
  receiverAccount: string;
  amount: number;
  paymentDate: string | null;
  token: string;
}

const TOKEN_RE = /https?:\/\/receipt\.ebirr\.com\/(kaafimf|coopay)\/\s*([A-Za-z0-9_-]{22})/gi;
const STUB_RE = /receipt\.ebirr\.com\/(kaafimf|coopay)/gi;
const LEADERS = ["f", "l", "i", "j", "I", "1"];

function walletFor(value: string): EbirrWallet {
  return value.toLowerCase() === "kaafimf" ? "kaafimf" : "coopay";
}

function tokenCandidates(text: string): Array<{ wallet: EbirrWallet; token: string }> {
  const out: Array<{ wallet: EbirrWallet; token: string }> = [];
  const seen = new Set<string>();
  const joined = text.replace(/\s+/g, "");
  for (const match of joined.matchAll(TOKEN_RE)) {
    const candidate = { wallet: walletFor(match[1]), token: match[2] };
    const key = `${candidate.wallet}:${candidate.token}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(candidate);
    }
  }

  for (const match of text.matchAll(STUB_RE)) {
    const wallet = walletFor(match[1]);
    let index = (match.index || 0) + match[0].length;
    while (/\s/.test(text[index] || "")) index += 1;
    if (text[index] === "/") index += 1;
    while (/\s/.test(text[index] || "")) index += 1;
    const run = text.slice(index).match(/^[A-Za-z0-9_-]+/)?.[0] || "";
    if (run.length !== 21) continue;
    for (const leader of LEADERS) {
      const token = leader + run;
      const key = `${wallet}:${token}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ wallet, token });
      }
    }
  }
  return out;
}

function nextRowValue($: cheerio.CheerioAPI, label: string): string {
  const labelCell = $("td").filter((_, el) =>
    $(el).find("td").length === 0 &&
    $(el).text().trim().toLowerCase().includes(label.toLowerCase()),
  ).first();
  const value = labelCell.closest("tr").next("tr").find("td").first().text().trim();
  if (!labelCell.length || !value) throw new Error(`Missing eBirr receipt field: ${label}`);
  return value;
}

function sameRowValue($: cheerio.CheerioAPI, label: string): string | null {
  const labelCell = $("td").filter((_, el) =>
    $(el).find("td").length === 0 &&
    $(el).text().trim().toLowerCase().includes(label.toLowerCase()),
  ).first();
  return labelCell.length ? labelCell.next("td").text().trim() || null : null;
}

function parseAmount(value: string): number {
  const amount = Number(value.replace(/,/g, "").match(/[\d.]+/)?.[0]);
  if (!Number.isFinite(amount)) throw new Error("Invalid eBirr receipt amount");
  return amount;
}

function parseReceipt(html: string, sourceWallet: EbirrWallet, token: string): EbirrReceipt {
  const $ = cheerio.load(html);
  // Target the transaction-details header cell, not the surrounding section
  // heading whose text also contains "Receipt No.".
  const header = $("td.receipttableTd").filter((_, el) => /receipt no\./i.test($(el).text())).first();
  const cells = header.closest("tr").next("tr").find("td");
  if (!header.length || cells.length < 3) throw new Error("Invalid eBirr receipt details table");

  const transactionId = $(cells[0]).text().trim();
  const paymentDate = $(cells[1]).text().trim() || null;
  const amount = parseAmount($(cells[2]).text());
  let receiverName = nextRowValue($, "Receiver name");
  let receiverAccount = nextRowValue($, "Receiver Account/Mobile");
  let wallet = sourceWallet;

  if (/wallet to wallet/i.test(receiverName)) {
    const reason = sameRowValue($, "Payment Reason") || "";
    if (sourceWallet === "kaafimf") {
      const match = reason.match(/to\s+(.+?)\(([\w]+)\)\s+via\s+Cooperative\s+Bank/i);
      if (match) {
        receiverName = match[1].trim();
        receiverAccount = match[2].trim();
        wallet = "coopay";
      }
    } else {
      const match = reason.match(/merchant:\s*(.+?)\s*\(([\w]+)\)/i);
      if (match) {
        receiverName = match[1].trim();
        receiverAccount = match[2].trim();
        wallet = "kaafimf";
      }
    }
  }

  return {
    transactionId,
    wallet,
    senderName: nextRowValue($, "Sender Name"),
    senderAccount: nextRowValue($, "Sender Ebirr no"),
    receiverName,
    receiverAccount,
    amount,
    paymentDate,
    token,
  };
}

async function fetchAndParse(wallet: EbirrWallet, token: string): Promise<EbirrReceipt> {
  const url = `https://receipt.ebirr.com/${wallet}/${token}`;
  const response = await axios.get(url, { timeout: 15000, validateStatus: () => true });
  if (response.status < 200 || response.status >= 300 || typeof response.data !== "string") {
    throw new Error(`eBirr returned HTTP ${response.status}`);
  }
  if (/Not Found Page/i.test(response.data) || !/Receipt No\./i.test(response.data)) {
    throw new Error("eBirr receipt not found for the provided token");
  }
  return parseReceipt(response.data, wallet, token);
}

export async function verifyEbirrText(text: string, requestedWallet?: EbirrWallet): Promise<EbirrReceipt> {
  if (!text || typeof text !== "string") throw new Error("eBirr receipt text is required");
  let candidates = tokenCandidates(text);
  if (requestedWallet) candidates = candidates.filter((candidate) => candidate.wallet === requestedWallet);
  if (!candidates.length) throw new Error("eBirr receipt URL token was not found");

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      return await fetchAndParse(candidate.wallet, candidate.token);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error("eBirr receipt could not be verified");
}
