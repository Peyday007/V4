import { env } from '@/lib/env';

export type TranscriptSegment = {
  speaker: string;
  startSec: number;
  endSec: number;
  text: string;
};

export type TranscriptionResult = {
  provider: string;
  language: string;
  text: string;
  segments: TranscriptSegment[];
  durationSec: number;
};

export type TranscribeInput = {
  /** Storage key or URL of the recording. */
  audioRef: string;
  language?: string;
  /** Pre-supplied transcript text — used by demos and manually-logged calls. */
  syntheticText?: string;
};

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscribeInput): Promise<TranscriptionResult>;
}

/**
 * Mock transcription. When `syntheticText` is provided (seeded demo calls or a
 * caller pasting notes) it is segmented by speaker turns, so downstream fact
 * extraction runs against realistic input with no audio pipeline.
 */
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'mock';

  async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
    const text = input.syntheticText?.trim() || '[No audio available for this call.]';
    const segments: TranscriptSegment[] = [];
    let cursor = 0;

    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const match = /^([A-Za-z][\w .'-]{0,40}):\s*(.*)$/.exec(line);
      const speaker = match ? match[1] : 'Unknown';
      const body = match ? match[2] : line;
      const duration = Math.max(3, Math.round(body.split(/\s+/).length / 2.6));
      segments.push({ speaker, startSec: cursor, endSec: cursor + duration, text: body });
      cursor += duration;
    }

    return {
      provider: this.name,
      language: input.language ?? 'en',
      text,
      segments,
      durationSec: cursor,
    };
  }
}

/** Deepgram pre-recorded transcription with speaker diarization. */
export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'deepgram';

  constructor(private readonly apiKey: string) {}

  async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
    const response = await fetch(
      'https://api.deepgram.com/v1/listen?diarize=true&punctuate=true&utterances=true&model=nova-2',
      {
        method: 'POST',
        headers: { Authorization: `Token ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: input.audioRef }),
      },
    );
    if (!response.ok) throw new Error(`Deepgram failed: ${response.status}`);

    const json = (await response.json()) as {
      results: {
        channels: Array<{ alternatives: Array<{ transcript: string }> }>;
        utterances?: Array<{ speaker: number; start: number; end: number; transcript: string }>;
      };
      metadata: { duration: number };
    };

    const utterances = json.results.utterances ?? [];
    return {
      provider: this.name,
      language: input.language ?? 'en',
      text: utterances.length
        ? utterances.map((u) => `Speaker ${u.speaker}: ${u.transcript}`).join('\n')
        : json.results.channels[0]?.alternatives[0]?.transcript ?? '',
      segments: utterances.map((u) => ({
        speaker: `Speaker ${u.speaker}`,
        startSec: u.start,
        endSec: u.end,
        text: u.transcript,
      })),
      durationSec: json.metadata.duration,
    };
  }
}

let cached: TranscriptionProvider | null = null;

export function getTranscription(): TranscriptionProvider {
  if (cached) return cached;
  const config = env();
  cached =
    config.TRANSCRIPTION_PROVIDER === 'deepgram' && config.DEEPGRAM_API_KEY
      ? new DeepgramTranscriptionProvider(config.DEEPGRAM_API_KEY)
      : new MockTranscriptionProvider();
  return cached;
}

export function setTranscription(provider: TranscriptionProvider | null): void {
  cached = provider;
}
