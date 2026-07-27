# Integrations

Every external service is behind an interface in `lib/providers/`. Each ships with a mock that fully exercises the dependent code path, so the whole platform runs with zero credentials. Switching to a real provider is one environment variable plus its keys — no code above the interface changes.

---

## AI (`lib/providers/llm.ts`)

```ts
interface LLMProvider {
  structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
```

Every call supplies a Zod schema **and** a `fallback()` — a deterministic result computed by the rule engines. This is deliberate: the rules are the product, and the LLM improves phrasing and extraction recall on top of them.

**Mock (default).** Returns the fallback. Everything works; results are repeatable, which is what makes the engines testable.

**Anthropic.** Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Uses the Messages API with tool-use to constrain output to the Zod schema (converted by the local `toJsonSchema`). On any failure — network, rate limit, schema mismatch — it logs and returns the deterministic fallback rather than stalling the board.

```bash
LLM_PROVIDER="anthropic"
ANTHROPIC_API_KEY="sk-ant-..."
ANTHROPIC_MODEL="claude-sonnet-5"
```

Adding a provider: implement `LLMProvider`, register it in `getLLM()`.

---

## Telephony (`lib/providers/telephony.ts`)

```ts
interface TelephonyProvider {
  placeCall(input: PlaceCallInput): Promise<PlaceCallResult>;
  getStatus(providerCallId: string): Promise<CallStatus>;
  hangup(providerCallId: string): Promise<void>;
  verifyWebhook(headers: Record<string, string>, rawBody: string): boolean;
}
```

**Mock (default).** Issues stable synthetic call ids. The caller works the console normally and pastes the transcript, so the recording → transcription → extraction path runs without a carrier.

**Twilio.** Set:

```bash
TELEPHONY_PROVIDER="twilio"
TWILIO_ACCOUNT_SID="AC..."
TWILIO_AUTH_TOKEN="..."
TWILIO_FROM_NUMBER="+15551234567"
```

Point these Twilio webhooks at your deployment:

| Twilio setting | URL |
|---|---|
| Voice URL | `${APP_URL}/api/webhooks/telephony/twiml` |
| Status callback | `${APP_URL}/api/webhooks/telephony/status` |
| Recording callback | `${APP_URL}/api/webhooks/telephony/recording` |

`verifyWebhook` implements Twilio's HMAC-SHA1 signature check over the URL plus sorted parameters. **Handlers for these routes are not implemented** — the outbound path and the abstraction are complete, but the inbound receivers are left for the deployment that wires a real carrier. Each should verify the signature, resolve the `Call` by `providerCallId`, update status/duration, store the recording via `StorageProvider`, and enqueue `transcription.process`.

`lib/calling.ts` already handles the parts that matter: the compliance gate before dialling, the recording-consent decision and its recorded basis, attempt limits, and the hand-off to the analysis pipeline.

---

## Transcription (`lib/providers/transcription.ts`)

```ts
interface TranscriptionProvider {
  transcribe(input: TranscribeInput): Promise<TranscriptionResult>;
}
```

**Mock (default).** Segments `syntheticText` by speaker turns (`Speaker: text` lines), producing the same `TranscriptSegment[]` shape a real provider returns. This is what lets the seed and the call console drive genuine fact extraction with no audio.

**Deepgram.** `TRANSCRIPTION_PROVIDER=deepgram` and `DEEPGRAM_API_KEY`. Uses nova-2 with diarization and utterances.

Speaker labelling matters downstream: `isOurSide()` decides which turns become business facts, matching the caller's name tokens or generic labels (`Caller`, `Agent`, `Rep`). Only the *other* party's statements become facts about their business; our own become commitments. If your provider emits `Speaker 0` / `Speaker 1`, map them to names before storing, or extend `OUR_SPEAKER_TOKENS`.

---

## Email (`lib/providers/email.ts`)

**Mock (default).** Captures to an in-memory outbox and logs the subject and recipient. Demos never contact a real address.

**SMTP.** `EMAIL_PROVIDER=smtp` and `SMTP_URL`. `SmtpEmailProvider.send` throws with a pointer to this file — wire nodemailer or the provider SDK there. The interface is the only contract the rest of the app depends on.

Documents that create obligations (`QUOTE`, `PROPOSAL`, `STATEMENT_OF_WORK`, `PURCHASE_ORDER`, `CONTRACT`, `CHANGE_ORDER`, `FULFILLMENT_INSTRUCTIONS`) are created `PENDING_APPROVAL` with an `Approval` record attached, and cannot be sent until a manager decides.

---

## Storage (`lib/providers/storage.ts`)

**Local (default).** Files under `STORAGE_LOCAL_DIR`, keys hashed into a two-level tree, written mode `0600`. Never served statically — only through `/api/files`, which authenticates, verifies org ownership, honours link expiry and audits the download.

**S3.** `STORAGE_PROVIDER=s3`, `S3_BUCKET`, `S3_REGION`. Methods throw with a pointer here; implement with `@aws-sdk/client-s3` and presigned URLs.

---

## Discovery connectors (`lib/discovery/connector.ts`)

```ts
interface DiscoveryConnector {
  readonly key: string;
  readonly sourceType: SourceType;
  readonly defaultCategory: SignalCategory;
  /** Documented reason this access is permitted. Shown in the UI. */
  readonly accessBasis: string;
  fetch(context: ConnectorContext): Promise<RawRecord[]>;
}
```

Seven connectors ship: contract awards, building permits, job postings, bid/RFQ portals, supplier directories, press releases (all fixture-backed) and CSV import (real, for first-party data).

### Writing a live connector

1. Implement `fetch`, returning `RawRecord[]`.
2. Set `subjectRole` — the named company's role *in the situation the record describes*. This is not optional nicety: an award notice saying "prime contractor is expected to subcontract" contains supplier and subcontractor language describing *other* parties, and inferring the subject's role from that text files buyers as suppliers.
3. Set `describesSubject: true` only when the excerpt is the company describing itself (a directory listing). That is the sole case where keyword role inference is allowed to run.
4. Register in `BUILT_IN_CONNECTORS`.
5. Add a `DataSource` row with a truthful `accessBasis`.

Everything downstream — evidence, deduplication, signal detection, company resolution, promotion — is shared.

### Access rules

Connectors must respect robots directives, published rate limits, authentication boundaries, contractual restrictions and applicable law. Do not bypass access controls, log into a portal on a user's behalf, or retrieve anything behind authentication. `accessBasis` is displayed next to every source in the UI so the justification stays visible. Confirm a source's terms permit the intended access and use before enabling it.

---

## Adding an integration

1. Define the interface in `lib/providers/<service>.ts`.
2. Write the mock first, and make it exercise the real code path — a mock that returns `{}` proves nothing.
3. Implement the real provider; fail loudly with a pointer to this file when unconfigured.
4. Add a `get<Service>()` selector reading a single environment variable, plus a `set<Service>()` test seam.
5. Add the variables to `.env.example` with a comment on what happens when they are absent.
6. Document it here.
