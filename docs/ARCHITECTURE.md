# Architecture notes

A tour of the decisions behind the system, and a few of the things that could only be learned from a real iPhone.

## 1. One origin, on purpose

The web app, the enrollment pages and the API all live on one domain. Firebase Hosting serves the static app and rewrites `/v1/**`, `/shops/**`, `/enroll/**`, `/signup/**` and `/legal/**` to a Cloud Run service.

This is not only about avoiding CORS. Every Apple Wallet pass carries a `webServiceURL` that is welded in at issue time and can never be rewritten. Issuing passes against a raw Cloud Run URL would have locked the system to that URL forever. Issuing them against a domain we control made the later move to the product's own domain a DNS change, with no pass reissued.

## 2. The service, not Cloud Functions

The pass service is a long-lived Node process on Cloud Run because it needs:

- the Apple signing certificate loaded at boot (mounted from Secret Manager),
- a persistent HTTP/2 connection to APNs, authenticated with that certificate,
- Apple-dictated URL paths (`/v1/devices/...`, `/v1/passes/...`, `/v1/log`) mounted at the root.

`min-instances=1` was the cheapest latency the system will ever buy: a cold start measured 3.5 s at the counter, which a barista reads as "the scan failed" and taps again.

## 3. Layers

```
services/pass-service/src
  domain/      enroll, addStamp, redeem, adjust, undo, broadcast — pure rules + Firestore transactions
  wallet/      WalletProvider interface; Apple, Google, Noop and Routing implementations
  apple/       .pkpass building and signing, APNs, Apple's PassKit Web Service, strip art
  google/      JWT signer, save link, REST client, card → class/object mapping
  http/        Fastify routes, Zod schemas, auth, rate limiting, enrollment and legal pages
  firestore/   Admin SDK client, collection paths, converters, device registrations
packages/shared
  types, and the card-rendering code both the browser preview and the pass builder call
web/src
  / landing, /start wizard, /scan scanner, /admin dashboard; editors shared by wizard and dashboard
```

`domain/` may not import from `apple/` or `google/`. An architecture test walks every import and fails the build on a violation. Google Wallet was added months after Apple by writing a second provider and a one-file router keyed on `customer.platform`; no Apple call site changed.

## 4. Data model

```
shops/{shopId}
  program: { kind: 'stamps' | 'points', goal, rewardText, defaultAward, cooldownSeconds }
  signup:  which fields the form asks for
  card:    colours, logo text, fields [{ slot, label, source }]
  consent: per-shop consent items (versioned)

shops/{shopId}/staff/{uid}              the team list; the authorization is the auth claim
shops/{shopId}/customers/{customerId}   serial, per-pass auth token, cached balance, profile, platform
shops/{shopId}/transactions/{txId}      append-only; txId derived from the idempotency key
shops/{shopId}/registrations/...        Apple device ↔ pass registrations
```

Every mutation runs inside one Firestore transaction: read shop and customer, validate against the rules, append the transaction row, update the cached balance. A replayed idempotency key finds its own row and returns `applied: false`. An `/audit` endpoint recomputes the balance from the log and reports whether the cache agrees.

Firestore security rules deny every client everything. The browser imports Firebase Auth and nothing else; all reads and writes go through the service, which uses the Admin SDK. This closed a real hole: a barista's token plus the public web config used to be enough to list every customer's details with the client SDK.

## 5. Authentication and tenancy

Staff are Firebase Auth users whose `shopId` and `role` live in **custom claims**, which only the Admin SDK can set. The service stamps them at signup and from the dashboard's Team screen. Every route compares the claim against the `shopId` in the path; a token for one shop cannot touch another. A dev-only mode that takes identity from headers (so the lifecycle check can be driven by `curl`) refuses to start under `NODE_ENV=production`.

The unauthenticated surface (enrollment, Apple's web service, `/v1/log`) has per-address rate limits that count *failures*, not requests, so a café wifi full of phones refreshing after a broadcast is never throttled.

## 6. Things only a device can teach you

These each cost real debugging. They are the reason the code looks the way it does.

- **`/healthz` is reserved by Google.** Cloud Run's frontend answers it with its own 404 before the request reaches the container. Ours is `/health`.
- **An APNs pass push carries no data.** The payload is `{}`; it is a doorbell. The device then calls `passesUpdatedSince` and fetches the pass. A shop-level change therefore pushes nothing on its own, because no customer's `updatedAt` moved. The system bumps every card deliberately.
- **`apns-expiration` defaults to 0, which means "try once, then discard".** On wifi a phone holds a live APNs connection and updates in under a second; on cellular it often does not, and the update was simply gone. Setting it to a day made APNs store and retry.
- **`apns-push-type: background` is wrong for Wallet** and is what caused the wifi/cellular split; its contract requires an app bundle id and a `content-available` payload, neither of which a pass has. Apple's own list has no entry for Wallet, so the value that lies least is `alert`, at priority 10.
- **"No matching passes" must be 204, not 404.** A 404 is an *error* to Wallet; it backs off the exact task that fetches updates after a push. A test had asserted the 404, which is how it survived.
- **A device must be allowed to unregister a pass whose customer is gone.** A 401 is retryable, so a card from a deleted shop retried forever.
- **Wallet drops fields past a slot's capacity silently.** Refused at the settings endpoint, hidden in the designer, truncated deterministically in the builder as a last resort.
- **`/v1/log` is the only place iOS says why a pass will not update.** Wallet reports failures nowhere else.
- **Firestore range filters with no `orderBy` sort ascending**, and the emulator auto-creates whatever index a query asks for, so a missing composite index can only be caught in production.
- **The service worker must never cache the API.** When the API moved to the same origin, a cross-origin exclusion silently stopped applying and stamp counts froze on the scanner.
- **Google takes 1–2 s to accept a PATCH.** The barista never waits for it: pushes run behind the reply, coalesced per card, and `settle()` flushes them on shutdown.

## 7. Testing

- Pure rules (cooldown boundaries, surplus redemption, replayed keys) are unit tested without a database.
- Operations are integration tested against the Firestore emulator; each test file uses its own project id so parallel files cannot clear each other's data.
- Architecture tests enforce module boundaries and that no TypeScript syntax needing a compile step is used (the service runs on Node's type stripping).
- A `curl`-driven lifecycle script asserts 28 behaviours end to end, including tenancy isolation and that the cached balance agrees with the log. It runs unchanged against the Docker image.
- Golden tests pin the `.pkpass` output for a shop's card so an artwork change is a visible diff.
- A `.pkpass` → PNG previewer draws a signed pass the way Wallet lays it out, so a card can be looked at without AirDropping it to a phone.
