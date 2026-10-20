// Excerpt from the private production repository, included for illustration.
// It is not runnable on its own: imports refer to modules that are not published here.

import http2 from 'node:http2';
import type { SigningCertificates } from './certificates.ts';

/**
 * APNs client for Wallet pass updates (LOYALTY_PROJECT.md §5).
 *
 * Two things about Wallet pushes surprise people:
 *
 *   - **The payload is empty.** `{}` carries no stamp count and no data at all.
 *     It is a doorbell: the device is told something changed and then fetches
 *     the new pass from our web service. Nothing here can "send" a balance.
 *   - **Authentication is the pass signing certificate itself**, presented as a
 *     client TLS certificate. That is why this is a long-lived Cloud Run
 *     process and not a Cloud Function (§3): the HTTP/2 connection is expensive
 *     to establish and meant to be kept.
 *
 * The topic is the pass type identifier, not an app bundle id.
 */
/**
 * How long APNs may keep trying to deliver a pass update, in seconds.
 *
 * A day. This header is the whole of our late-delivery strategy, so it is worth
 * being precise about what it buys: APNs stores a notification it could not
 * deliver and forwards it when the device next comes online, discarding it only
 * once this expiry passes. A phone that is off, in a tunnel, in airplane mode
 * or simply out of signal therefore gets its doorbell on reconnect — from
 * Apple's infrastructure, at no cost to us, with nothing on our side needing to
 * remember that it was owed one.
 *
 * A day is long enough to cover a phone left off overnight and short enough
 * that a customer never sees a doorbell for a change that has since been
 * superseded — and if it is, the fetch it triggers returns the *current* card
 * from Firestore anyway, not the stale one the push was about.
 *
 * Unset, this header is 0, which means APNs attempts delivery exactly once and
 * throws the notification away if the device is not reachable at that instant.
 * That was the original bug: on wifi a phone holds a live APNs connection and
 * the update lands in under a second, on cellular it often does not, and the
 * card simply never updated.
 */
const PUSH_EXPIRY_WINDOW_SECONDS = 24 * 60 * 60;

const PRODUCTION_HOST = 'https://api.push.apple.com:443';

export type ApnsOutcome =
  | { status: 'sent'; pushToken: string }
  /** APNs 410: the device is gone for good. Delete the registration (§5). */
  | { status: 'unregistered'; pushToken: string }
  | { status: 'failed'; pushToken: string; reason: string };

export interface ApnsClientOptions {
  certificates: SigningCertificates;
  /** The pass type id, used as the APNs topic. */
  topic: string;
  host?: string;
  /** Milliseconds to wait for a single push before giving up. */
  timeoutMs?: number;
}

export class ApnsClient {
  readonly #certificates: SigningCertificates;
  readonly #topic: string;
  readonly #host: string;
  readonly #timeoutMs: number;
  #session: http2.ClientHttp2Session | undefined;

  constructor(options: ApnsClientOptions) {
    this.#certificates = options.certificates;
    this.#topic = options.topic;
    this.#host = options.host ?? PRODUCTION_HOST;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Sends the empty notification that tells a device to re-fetch a pass.
   *
   * Never throws: a push failure must not turn into a failed stamp (§2.2). The
   * outcome is returned so the caller can act on 410 and log the rest.
   */
  async push(pushToken: string): Promise<ApnsOutcome> {
    try {
      const session = await this.#connect();
      return await this.#send(session, pushToken);
    } catch (err) {
      return { status: 'failed', pushToken, reason: describe(err) };
    }
  }

  async close(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (!session || session.destroyed) return;
    await new Promise<void>((resolve) => {
      // close() waits for in-flight streams; if none are outstanding it is
      // immediate. destroy() afterwards releases the socket unconditionally.
      session.close(() => {
        session.destroy();
        resolve();
      });
    });
  }

  async #connect(): Promise<http2.ClientHttp2Session> {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) {
      return this.#session;
    }

    const session = http2.connect(this.#host, {
      cert: this.#certificates.signerCert,
      key: this.#certificates.signerKey,
    });

    // A dead session must not be reused, or every later push fails silently.
    session.on('error', () => {
      if (this.#session === session) this.#session = undefined;
    });
    session.on('close', () => {
      if (this.#session === session) this.#session = undefined;
    });

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        session.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        session.off('connect', onConnect);
        // Destroy the half-open session before giving up. Left alone it keeps
        // a socket handle alive, which holds the event loop open — a process
        // that will not exit is a nasty way to discover APNs was unreachable.
        session.destroy();
        reject(err);
      };
      session.once('connect', onConnect);
      session.once('error', onError);
    });

    this.#session = session;
    return session;
  }

  async #send(session: http2.ClientHttp2Session, pushToken: string): Promise<ApnsOutcome> {
    return new Promise<ApnsOutcome>((resolve) => {
      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${pushToken}`,
        'apns-topic': this.#topic,
        /*
         * `alert`, not `background`, and priority 10, not 5.
         *
         * Apple has no push type for Wallet: the documented list is alert,
         * background, complication, controls, fileprovider, liveactivity,
         * location, mdm, pushtotalk, voip and widgets, and none of them is a
         * pass update. `background` is not a neutral choice among those — it
         * has two documented requirements we cannot meet:
         *
         *   - "the `apns-topic` header field must use your app's bundle ID as
         *     the topic". Ours is a Pass Type ID. There is no app.
         *   - a background payload is `{"aps":{"content-available":1}}`. Ours
         *     must be `{}`, because that is what the Wallet spec mandates and
         *     what passd parses; sending `content-available` makes the device
         *     log "Unable to deserialize JSON message payload".
         *
         * So declaring `background` describes a notification we are not
         * sending. Apple is explicit about the cost: the value "must
         * accurately reflect the contents of your notification's payload. If
         * there's a mismatch [...] APNs may return an error, delay the
         * delivery of the notification, or drop it altogether."
         *
         * That is the wifi/cellular split exactly. A phone on wifi holds a
         * live APNs connection and gets the push before any of this matters; a
         * phone on cellular depends on the stored-and-forwarded path, which is
         * where the delay and the dropping happen. It also brought us under
         * the background-notification budget — "don't try to send more than
         * two or three per hour", "the system doesn't guarantee their
         * delivery" — which a till stamping cards blows through in minutes.
         *
         * Priority 5 is "send the notification based on power considerations
         * on the user's device", and Apple warns such pushes "might get
         * grouped and delivered in bursts [...] throttled, saved in storage,
         * and in some cases, not delivered". A customer is standing at the
         * counter watching the card, so 10 — "send the notification
         * immediately" — is the honest description. 10 is an error under
         * `background` and correct under `alert`.
         *
         * The payload stays `{}`. This does not make the push user-visible:
         * Wallet shows a notification only when the new pass carries a
         * changeMessage.
         */
        'apns-priority': '10',
        'apns-push-type': 'alert',
        // Store-and-forward, not fire-and-forget. See the constant.
        'apns-expiration': String(Math.floor(Date.now() / 1000) + PUSH_EXPIRY_WINDOW_SECONDS),
        'content-type': 'application/json',
      });

      let status = 0;
      let body = '';
      let settled = false;
      const settle = (outcome: ApnsOutcome) => {
        if (settled) return;
        settled = true;
        req.close();
        resolve(outcome);
      };

      req.setTimeout(this.#timeoutMs, () =>
        settle({ status: 'failed', pushToken, reason: 'timeout' }),
      );
      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('error', (err) => settle({ status: 'failed', pushToken, reason: describe(err) }));
      req.on('end', () => {
        if (status === 200) return settle({ status: 'sent', pushToken });
        if (status === 410) return settle({ status: 'unregistered', pushToken });
        settle({
          status: 'failed',
          pushToken,
          reason: `apns ${status}${body ? `: ${reasonFrom(body)}` : ''}`,
        });
      });

      // The empty payload. This is the whole message.
      req.end('{}');
    });
  }
}

function reasonFrom(body: string): string {
  try {
    return String((JSON.parse(body) as { reason?: string }).reason ?? body);
  } catch {
    return body.slice(0, 120);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
