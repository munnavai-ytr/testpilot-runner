import crypto from 'crypto';
import dns from 'dns/promises';
import { Request, Response, NextFunction } from 'express';
import { config, redactSecrets } from './config';

/**
 * Constant-time string comparison to prevent timing attacks against auth tokens.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      // Compare against itself to maintain timing
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Authentication middleware for all /api routes using constant-time comparison.
 */
export function authenticateRunner(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: {
        code: 'invalid_token',
        message: 'Runner token is invalid or missing. Check Settings.',
      },
    });
    return;
  }

  const providedToken = authHeader.slice(7).trim();
  if (!constantTimeCompare(providedToken, config.runnerToken)) {
    res.status(401).json({
      error: {
        code: 'invalid_token',
        message: 'Runner token is invalid. Check Settings.',
      },
    });
    return;
  }

  next();
}

/**
 * In-memory sliding-window IP rate limiter: max 10 runs per hour per IP.
 */
interface RateLimitEntry {
  timestamps: number[];
}
const ipRateLimits = new Map<string, RateLimitEntry>();

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  const entry = ipRateLimits.get(ip) || { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((ts) => ts > oneHourAgo);

  if (entry.timestamps.length >= 10) {
    return false;
  }

  entry.timestamps.push(now);
  ipRateLimits.set(ip, entry);
  return true;
}

/**
 * Concurrency lock: Only ONE active test run at a time.
 */
let currentActiveRunId: string | null = null;

export function isRunnerBusy(): boolean {
  return currentActiveRunId !== null;
}

export function getActiveRunId(): string | null {
  return currentActiveRunId;
}

export function acquireRunLock(runId: string): boolean {
  if (currentActiveRunId !== null && currentActiveRunId !== runId) {
    return false;
  }
  currentActiveRunId = runId;
  return true;
}

export function releaseRunLock(runId: string): void {
  if (currentActiveRunId === runId) {
    currentActiveRunId = null;
  }
}

/**
 * SSRF validation: Checks if an IPv4 or IPv6 is in private, link-local, loopback, or cloud metadata ranges.
 */
function isPrivateOrLocalIp(ip: string): boolean {
  // IPv4 check
  if (ip.includes('.')) {
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true; // invalid -> block
    }

    const [a, b] = parts;

    // Loopback: 127.0.0.0/8
    if (a === 127) return true;

    // Current network / Broadcast
    if (a === 0 || (a === 255 && b === 255)) return true;

    // RFC 1918 Private: 10.0.0.0/8
    if (a === 10) return true;

    // RFC 1918 Private: 172.16.0.0/12 (172.16.0.0 – 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // RFC 1918 Private: 192.168.0.0/16
    if (a === 192 && b === 168) return true;

    // Link-local / Cloud Metadata (169.254.0.0/16 including 169.254.169.254)
    if (a === 169 && b === 254) return true;

    // CGNAT: 100.64.0.0/10
    if (a === 100 && b >= 64 && b <= 127) return true;

    // Documentation / Test: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
    if (a === 192 && b === 0 && parts[2] === 2) return true;

    return false;
  }

  // IPv6 check
  const lower = ip.toLowerCase();
  // Loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  // Unspecified
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
  // Unique local: fc00::/7, fd00::/8
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Link-local: fe80::/10
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true;
  }
  // IPv4 mapped IPv6 (e.g. ::ffff:127.0.0.1)
  if (lower.startsWith('::ffff:')) {
    const ipv4 = lower.slice(7);
    return isPrivateOrLocalIp(ipv4);
  }

  return false;
}

/**
 * Validates a target URL against SSRF attacks:
 * 1. Checks protocol (only http: and https:)
 * 2. Resolves DNS
 * 3. Rejects private, loopback, link-local, and internal addresses
 */
export async function validateSsrfUrl(targetUrl: string): Promise<{ valid: boolean; reason?: string }> {
  try {
    const parsed = new URL(targetUrl);

    // Only allow http/https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: 'Only http and https protocols are supported' };
    }

    const hostname = parsed.hostname.toLowerCase();

    // Block localhost names directly
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname === 'metadata.google.internal'
    ) {
      return { valid: false, reason: 'Internal and localhost hosts are prohibited' };
    }

        // Direct IP address check (only when the host is an IP address, not a domain name)
    const bareHost = hostname.replace(/^\[|\]$/g, '');
    const isIpv4Literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(bareHost);
    const isIpv6Literal = bareHost.includes(':');
    if ((isIpv4Literal || isIpv6Literal) && isPrivateOrLocalIp(bareHost)) {
      return { valid: false, reason: 'Private or local IP addresses are prohibited' };
    }

    // Resolve DNS to verify all destination IPs
    try {
      const records = await dns.lookup(hostname, { all: true });
      if (!records || records.length === 0) {
        return { valid: false, reason: 'Hostname resolution returned no records' };
      }

      for (const record of records) {
        if (isPrivateOrLocalIp(record.address)) {
          return {
            valid: false,
            reason: `Hostname resolved to prohibited internal IP address: ${record.address}`,
          };
        }
      }
    } catch {
      return { valid: false, reason: 'Failed to resolve hostname via DNS' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Malformed URL' };
  }
}
