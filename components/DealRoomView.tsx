import type { RoomContent } from '@/lib/room/content';

/**
 * The Deal Room page itself.
 *
 * One component. The owner preview and the public page both render this, from
 * the same snapshot, through the same data function — so "what does the
 * prospect see" is a question with one answer. Two renderers would drift inside
 * a week, and the one nobody looks at is the one the customer gets.
 *
 * `mode` changes exactly two things: whether the actions are wired up, and
 * whether the owner-only annotations are shown. It does not change a word of
 * the content, which is the point.
 *
 * On the writing: everything here is either something a named source stated,
 * something the buyer told us, or something explicitly marked as our
 * assumption. There is no urgency we invented, no savings figure we cannot
 * substantiate, and no analysis we did not perform. The page is meant to be
 * worth reading with every button removed — if the only reason to stay on it is
 * the call to action, there was nothing worth sending.
 */

export function DealRoomView({
  content,
  mode,
  token,
  closedReason,
  alreadyRequested,
}: {
  content: RoomContent;
  mode: 'public' | 'preview';
  token?: string;
  closedReason?: string | null;
  alreadyRequested?: boolean;
}) {
  if (closedReason) {
    return (
      <main className="room" data-testid="room-closed">
        <h1>{content.organisation}</h1>
        <p className="room-lede">{closedReason}</p>
      </main>
    );
  }

  return (
    <main className="room" data-testid="room">
      {mode === 'preview' && (
        <div className="alert small" data-testid="preview-banner">
          <strong>Preview.</strong> This is exactly what the prospect sees, rendered from the same snapshot by the
          same component. Opening it here records nothing.
        </div>
      )}

      <header>
        <h1>{content.organisation}</h1>
        {content.location && <p className="room-meta">{content.location}</p>}
      </header>

      {content.why && (
        <section data-testid="room-why">
          <h2>Why you are hearing from us</h2>
          <p className="room-lede">{content.why.text}</p>
          <p className="room-source">
            Dated {content.why.eventDate} in {content.why.source}.
            {content.why.sourceUrl && (
              <>
                {' '}
                <a href={content.why.sourceUrl} target="_blank" rel="noreferrer noopener nofollow">
                  The record itself ↗
                </a>
              </>
            )}
          </p>
        </section>
      )}

      {content.sections.map((section) => (
        <section key={section.heading} data-testid="room-section">
          <h2>{section.heading}</h2>

          {section.facts.length > 0 && (
            <dl className="room-facts">
              {section.facts.map((fact) => (
                <div key={`${fact.label}:${fact.value}`}>
                  <dt>{fact.label}</dt>
                  <dd>
                    {fact.value}
                    <span className="room-source"> {fact.source}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {section.ours.length > 0 && (
            <div className="room-ours" data-testid="room-ours">
              <p className="room-source">Our reading, not something you have told us:</p>
              <ul>
                {section.ours.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          )}

          {section.questions.length > 0 && (
            <div className="room-questions">
              <p className="room-source">What we do not know:</p>
              <ul>
                {section.questions.map((question) => <li key={question}>{question}</li>)}
              </ul>
            </div>
          )}
        </section>
      ))}

      {content.price && (
        <section data-testid="room-price">
          <h2>The price we have put together</h2>
          <p className="room-lede">{content.price.amount}</p>
          <p className="room-source">
            {content.price.terms ? `${content.price.terms}. ` : ''}
            {content.price.validUntil
              ? `Held until ${content.price.validUntil}.`
              : 'No expiry date set on it.'}{' '}
            Against the scope described above — if that scope is wrong, the number is wrong, and we would rather
            hear about it than defend it.
          </p>
        </section>
      )}

      <section data-testid="room-step">
        <h2>What we suggest next</h2>
        <p className="room-lede">{content.proofStep.ask}</p>
        <dl className="room-facts">
          <div>
            <dt>What it commits you to</dt>
            <dd>{content.proofStep.commitment}</dd>
          </div>
          <div>
            <dt>What it settles</dt>
            <dd>{content.proofStep.tests}</dd>
          </div>
        </dl>

        {mode === 'public' && token && (
          <RoomActions token={token} alreadyRequested={Boolean(alreadyRequested)} />
        )}

        {mode === 'preview' && (
          <div className="alert small" data-testid="preview-reasoning">
            <strong>Why this step:</strong> {content.proofStepReason}
            {content.withheldSteps.length > 0 && (
              <ul>
                {content.withheldSteps.map((w) => (
                  <li key={w.kind}>
                    <strong>{w.kind.toLowerCase().replace(/_/g, ' ')}</strong> withheld — {w.because}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <footer className="room-footer">
        <p className="room-source">
          Everything above is either quoted from a public record, something you told us, or explicitly marked as our
          assumption. If any of it is wrong, telling us saves us both a conversation.
        </p>
      </footer>
    </main>
  );
}

/**
 * The buyer's side of the page.
 *
 * Plain form posts rather than a client component: this page is opened from an
 * email on whatever device the prospect happens to hold, and it should work
 * with no JavaScript at all. Declining is given the same weight as accepting,
 * because a page where saying no is harder than saying yes is a page that
 * collects false interest.
 */
function RoomActions({ token, alreadyRequested }: { token: string; alreadyRequested: boolean }) {
  if (alreadyRequested) {
    return (
      <p className="room-source" data-testid="room-already">
        You have already asked us to arrange this. Somebody will be in touch — there is no need to do it again.
      </p>
    );
  }

  return (
    <form method="post" action={`/api/room/${token}/respond`} className="room-actions" data-testid="room-actions">
      <label htmlFor="note">
        Anything you want to add, correct, or ask
        <textarea id="note" name="note" rows={4} maxLength={4000} />
      </label>

      <div className="room-buttons">
        <button type="submit" name="action" value="PROOF_STEP_REQUESTED">Yes, arrange this</button>
        <button type="submit" name="action" value="QUOTE_REQUESTED" className="secondary">Send me a price</button>
        <button type="submit" name="action" value="INFORMATION_SUPPLIED" className="secondary">Send this information</button>
        <button type="submit" name="action" value="DECLINED" className="secondary">Not interested — stop contacting me</button>
      </div>
    </form>
  );
}
