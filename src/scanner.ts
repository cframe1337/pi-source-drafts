import type { DraftMeta } from "./journal.ts";

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CC = /\b(?:\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/g;
const PHONE_CIS = /(?:\+7|8)[-.\s]?\d{3}[-.\s]?\d{3}[-.\s]?\d{2}[-.\s]?\d{2}\b/g;
const PHONE_US = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const API_KEYS = /\b(sk-|pk-|rk-)[a-zA-Z0-9]{20,}/g;
const AWS_KEYS = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GITHUB_TOKENS = /\b(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9_]{22,}\b/g;
const PRIVATE_KEYS = /-----BEGIN\s+(RSA|EC|OPENSSH|DSA|PRIVATE)\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA|EC|OPENSSH|DSA|PRIVATE)\s+PRIVATE\s+KEY-----/g;
const BEARER = /\b(Bearer\s+|Bearer:\s*)[a-zA-Z0-9._-]{20,}/g;
const GENERIC_SECRET = /(?:api[_-]?key|apikey|secret|password|token)\s*[:=]\s*['"]?[a-zA-Z0-9_\-.]{8,}/gi;

interface Pattern {
  regex: RegExp;
  replacement: string | ((m: string) => string);
  name: string;
}

const PATTERNS: Pattern[] = [
  { regex: SSN, replacement: "[SSN-REDACTED]", name: "ssn" },
  { regex: CC, replacement: "[CC-REDACTED]", name: "cc" },
  { regex: PHONE_CIS, replacement: "[PHONE-REDACTED]", name: "phone-cis" },
  { regex: PHONE_US, replacement: "[PHONE-REDACTED]", name: "phone-us" },
  { regex: API_KEYS, replacement: (m: string) => m.slice(0, 4) + "[REDACTED]", name: "api-key" },
  { regex: AWS_KEYS, replacement: (m: string) => m.slice(0, 4) + "[REDACTED]", name: "aws-key" },
  { regex: GITHUB_TOKENS, replacement: (m: string) => m.slice(0, 4) + "[REDACTED]", name: "github-token" },
  { regex: PRIVATE_KEYS, replacement: "[PRIVATE-KEY-REDACTED]", name: "private-key" },
  { regex: BEARER, replacement: (m: string) => (m.startsWith("Bearer:") ? "Bearer: [REDACTED]" : "Bearer [REDACTED]"), name: "bearer" },
  {
    regex: GENERIC_SECRET,
    replacement: (m: string) => {
      const idx = m.indexOf("=") !== -1 ? m.indexOf("=") : m.indexOf(":");
      return idx !== -1 ? m.slice(0, idx + 1) + " [REDACTED]" : m;
    },
    name: "generic-secret",
  },
];

export interface ScanResult {
  content: string;
  redacted: boolean;
  matchedPatterns: string[];
}

export function scanContent(content: string): ScanResult {
  let result = content;
  const matchedPatterns: string[] = [];

  for (const pattern of PATTERNS) {
    if (pattern.regex.test(result)) {
      pattern.regex.lastIndex = 0;
      matchedPatterns.push(pattern.name);
      if (typeof pattern.replacement === "function") {
        result = result.replace(pattern.regex, pattern.replacement);
      } else {
        result = result.replace(pattern.regex, pattern.replacement);
      }
    }
  }

  return {
    content: result,
    redacted: matchedPatterns.length > 0,
    matchedPatterns,
  };
}

export function scanMeta(meta: DraftMeta): DraftMeta {
  const result = { ...meta };
  const fieldsToScan: (keyof DraftMeta)[] = ["title", "sourceUrl", "projectDir", "sessionId", "sessionName", "model"];
  for (const field of fieldsToScan) {
    const val = result[field];
    if (typeof val === "string") {
      const scanned = scanContent(val);
      if (scanned.redacted) {
        (result as Record<string, unknown>)[field] = scanned.content;
      }
    }
  }
  return result;
}

export function scanSaveParams(params: { content: string; meta: DraftMeta }): { content: string; meta: DraftMeta; redacted: boolean } {
  const contentResult = scanContent(params.content);
  const metaResult = scanMeta(params.meta);
  return {
    content: contentResult.content,
    meta: metaResult,
    redacted: contentResult.redacted || metaResult !== params.meta,
  };
}
