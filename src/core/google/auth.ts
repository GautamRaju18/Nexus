/**
 * Google OAuth for a local desktop app (loopback redirect + PKCE).
 *
 * Security model:
 *   - The long-lived REFRESH token is stored AES-256-GCM encrypted in your vault.
 *   - ACCESS tokens (1-hour) are kept only in memory, never written to disk.
 *   - The OAuth flow uses PKCE and a one-shot loopback server on 127.0.0.1.
 *
 * You provide GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env (a "Desktop app"
 * OAuth client). See SETUP-GOOGLE.md.
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";
import type { Vault } from "../security/vault";
import type { Config } from "../../config";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_KEY = "google_refresh_token";

// Least-privilege scopes for Phase 1: read inbox, draft+send mail, manage calendar events.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose", // create drafts AND send
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
];

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export class GoogleAuth {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private vault: Vault,
    private cfg: Config,
  ) {}

  /** Are the app credentials present? */
  isConfigured(): boolean {
    return Boolean(this.cfg.googleClientId && this.cfg.googleClientSecret);
  }

  /** Has the user authorized (do we hold a refresh token)? */
  isConnected(): boolean {
    return this.vault.has(REFRESH_KEY);
  }

  /** Forget the Google grant (revoke locally). */
  disconnect(): void {
    this.vault.delete(REFRESH_KEY);
    this.accessToken = null;
    this.expiresAt = 0;
  }

  /** Interactive authorization. Opens the browser, captures the code on loopback. */
  async connect(log: (msg: string) => void): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error(
        "Google is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see SETUP-GOOGLE.md).",
      );
    }
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const { code, redirectUri } = await this.captureCode(challenge, log);

    const tok = await this.exchangeCode(code, verifier, redirectUri);
    if (!tok.refresh_token) {
      throw new Error(
        "Google returned no refresh token. Remove Nexus at myaccount.google.com/permissions and run /connect again.",
      );
    }
    this.vault.set(REFRESH_KEY, tok.refresh_token);
    this.cacheAccess(tok);
    log("Google connected ✓ (refresh token encrypted in your vault)");
  }

  /** A valid access token, refreshing transparently when needed. */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const refresh = this.vault.get(REFRESH_KEY);
    if (!refresh) throw new Error("Google not connected. Run /connect in the CLI.");

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.googleClientId,
        client_secret: this.cfg.googleClientSecret,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Google token refresh failed (${res.status}). You may need to /connect again.`);
    }
    const tok = (await res.json()) as TokenResponse;
    this.cacheAccess(tok);
    return this.accessToken!;
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private cacheAccess(tok: TokenResponse): void {
    this.accessToken = tok.access_token;
    this.expiresAt = Date.now() + (tok.expires_in - 60) * 1000; // refresh a minute early
  }

  private exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
    return fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.cfg.googleClientId,
        client_secret: this.cfg.googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return res.json() as Promise<TokenResponse>;
    });
  }

  private captureCode(
    challenge: string,
    log: (msg: string) => void,
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let redirectUri = "";
      const server = createServer((req, res) => {
        try {
          const url = new URL(req.url ?? "/", redirectUri);
          const code = url.searchParams.get("code");
          const err = url.searchParams.get("error");
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            "<html><body style='font-family:system-ui;padding:48px;text-align:center'>" +
              "<h2>Nexus is connected ✓</h2><p>You can close this tab and return to your terminal.</p></body></html>",
          );
          server.close();
          if (err) return reject(new Error(`Google authorization failed: ${err}`));
          if (!code) return reject(new Error("No authorization code received."));
          resolve({ code, redirectUri });
        } catch (e) {
          reject(e as Error);
        }
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        redirectUri = `http://127.0.0.1:${port}`;
        const authUrl =
          `${AUTH_URL}?` +
          new URLSearchParams({
            client_id: this.cfg.googleClientId,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: SCOPES.join(" "),
            access_type: "offline",
            prompt: "consent",
            code_challenge: challenge,
            code_challenge_method: "S256",
          }).toString();
        log("Opening your browser to authorize Google access…");
        log("If it doesn't open, paste this URL into your browser:\n  " + authUrl);
        openBrowser(authUrl);
      });
      setTimeout(
        () => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
          reject(new Error("Authorization timed out after 5 minutes."));
        },
        5 * 60 * 1000,
      ).unref();
    });
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* best-effort; the URL is also printed for manual open */
  });
}
