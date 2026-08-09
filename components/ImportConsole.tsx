'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { ImportPreview, ImportResult, ImportSide } from '@/lib/import';

/**
 * Getting real data in.
 *
 * Preview is a separate round trip that writes nothing, because the failure
 * everyone hits is a column the importer did not recognise — and finding that
 * out after two thousand rows are already in the database is much worse than
 * finding out before.
 */

const SIDE_HELP: Record<ImportSide, string> = {
  PROVIDER: 'Companies that do the work — subcontractors, suppliers, crews you would dispatch a job to.',
  BUYER: 'Companies that have the work — general contractors, facilities managers, anyone who would pay you.',
};

const TEMPLATES: Record<ImportSide, string> = {
  PROVIDER:
    'company_name,website,city,state,services,contact_name,title,email,mobile\n' +
    'Bright & Clean LLC,brightclean.example,Dallas,TX,"janitorial, floor care",Dana Reyes,Owner,dana@brightclean.example,214-555-0142\n' +
    'North Texas Facility Care,ntfacility.example,Plano,TX,janitorial,Sam Ortiz,Operations Manager,sam@ntfacility.example,972-555-0188\n',
  BUYER:
    'company_name,website,city,state,services,contact_name,title,email,phone\n' +
    'Trinity Property Group,trinitypg.example,Dallas,TX,"office cleaning",Alex Kim,Facilities Director,alex@trinitypg.example,214-555-0110\n',
};

export function ImportConsole({ canClear }: { canClear: boolean }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [csv, setCsv] = useState('');
  const [side, setSide] = useState<ImportSide>('PROVIDER');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearConfirm, setClearConfirm] = useState('');
  const [cleared, setCleared] = useState<Record<string, number> | null>(null);

  async function post(body: unknown, label: string) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch('/api/import/csv', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Request failed');
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function onPreview() {
    setResult(null);
    const payload = await post({ csv, side, dryRun: true }, 'preview');
    if (payload) setPreview(payload.preview as ImportPreview);
  }

  async function onImport() {
    const payload = await post({ csv, side, dryRun: false }, 'import');
    if (payload) {
      setResult(payload as ImportResult);
      setPreview(null);
      setCsv('');
      if (fileInput.current) fileInput.current.value = '';
      router.refresh();
    }
  }

  async function onClear() {
    setBusy('clear');
    setError(null);
    try {
      const response = await fetch('/api/import/csv', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: clearConfirm }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? payload.details?.[0] ?? 'Could not clear');
      setCleared(payload.cleared as Record<string, number>);
      setClearConfirm('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not clear');
    } finally {
      setBusy(null);
    }
  }

  function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result ?? ''));
      setPreview(null);
      setResult(null);
    };
    reader.readAsText(file);
  }

  const problemRows = preview?.rows.filter((row) => row.problems.length > 0) ?? [];

  return (
    <>
      {error && <div className="alert danger small">{error}</div>}

      {canClear && (
        <div className="card">
          <div className="card-title">
            <h2>Step 1 — clear the demonstration data</h2>
          </div>
          <p className="small muted">
            The seeded companies, opportunities, calls and numbers are fabricated. Removing them leaves your users, roles,
            industries, capabilities, territories, scripts, data sources, deal lanes and thresholds in place — the
            configuration is real work and survives. Everything transactional goes.
          </p>
          {cleared ? (
            <div className="alert success small">
              Removed {Object.entries(cleared).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing — it was already empty'}.
              The board is yours now.
            </div>
          ) : (
            <div className="row">
              <input
                aria-label="Type DELETE DEMO DATA to confirm"
                placeholder="Type DELETE DEMO DATA"
                value={clearConfirm}
                onChange={(e) => setClearConfirm(e.target.value)}
                style={{ maxWidth: 260 }}
              />
              <button className="danger" onClick={onClear} disabled={busy !== null || clearConfirm !== 'DELETE DEMO DATA'}>
                {busy === 'clear' ? 'Clearing…' : 'Clear demonstration data'}
              </button>
              <span className="tiny dim">This cannot be undone.</span>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-title">
          <h2>{canClear ? 'Step 2' : 'Step 1'} — load your companies</h2>
        </div>

        <div className="field">
          <label htmlFor="side">Which side of a deal is this list on?</label>
          <select id="side" value={side} onChange={(e) => { setSide(e.target.value as ImportSide); setPreview(null); }}>
            <option value="PROVIDER">Providers — they do the work</option>
            <option value="BUYER">Buyers — they have the work</option>
          </select>
          <div className="tiny dim mt">{SIDE_HELP[side]}</div>
          <div className="tiny dim">
            This is asked rather than guessed. A company filed on the wrong side never appears in matching, and nothing
            reports an error — it just quietly finds nobody.
          </div>
        </div>

        <div className="field">
          <label htmlFor="file">Upload a CSV</label>
          <input id="file" ref={fileInput} type="file" accept=".csv,text/csv" onChange={onFile} />
        </div>

        <div className="field">
          <label htmlFor="csv">…or paste it</label>
          <textarea
            id="csv"
            value={csv}
            placeholder={TEMPLATES[side]}
            rows={8}
            onChange={(e) => { setCsv(e.target.value); setPreview(null); setResult(null); }}
          />
          <div className="tiny dim">
            Column names are matched loosely — <span className="mono">company</span>, <span className="mono">business_name</span> and{' '}
            <span className="mono">account_name</span> all work. A column named{' '}
            <span className="mono">mobile</span> or <span className="mono">cell</span> marks the number as textable;{' '}
            <span className="mono">phone</span> does not.
          </div>
        </div>

        <div className="row">
          <button onClick={onPreview} disabled={busy !== null || csv.trim().length === 0}>
            {busy === 'preview' ? 'Checking…' : 'Check the file'}
          </button>
          <button className="primary" onClick={onImport} disabled={busy !== null || !preview || preview.usableRows === 0}>
            {busy === 'import' ? 'Importing…' : preview ? `Import ${preview.usableRows} companies` : 'Import'}
          </button>
          <button
            className="sm"
            onClick={() => { setCsv(TEMPLATES[side]); setPreview(null); setResult(null); }}
            disabled={busy !== null}
          >
            Fill in an example
          </button>
        </div>
      </div>

      {preview && (
        <div className="card">
          <div className="card-title">
            <h2>What the file contains</h2>
            <span className="badge">{preview.totalRows} rows read</span>
          </div>

          {preview.problems.map((problem) => (
            <div className="alert danger small" key={problem}>{problem}</div>
          ))}

          <div className="grid grid-4">
            <div className="stat">
              <div className="stat-label">Companies</div>
              <div className="stat-value">{preview.usableRows}</div>
              <div className="stat-sub">{preview.totalRows - preview.usableRows} rows skipped</div>
            </div>
            <div className="stat">
              <div className="stat-label">With a contact</div>
              <div className="stat-value">{preview.withContacts}</div>
              <div className="stat-sub">nobody to call on the rest</div>
            </div>
            <div className="stat">
              <div className="stat-label">Columns recognised</div>
              <div className="stat-value">{preview.recognisedHeaders.length}</div>
              <div className="stat-sub">{preview.recognisedHeaders.join(', ') || '—'}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Columns ignored</div>
              <div className="stat-value">{preview.unmappedHeaders.length}</div>
              <div className="stat-sub">{preview.unmappedHeaders.join(', ') || 'none'}</div>
            </div>
          </div>

          {problemRows.length > 0 && (
            <div className="alert warning small mt">
              {problemRows.length} row{problemRows.length === 1 ? '' : 's'} need attention. They are listed below and will
              still import unless they have no company name.
            </div>
          )}

          <div className="table-wrap mt">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Company</th>
                  <th>Where</th>
                  <th>Services</th>
                  <th>Contact</th>
                  <th>Problems</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 50).map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="dim">{row.rowNumber}</td>
                    <td>{row.companyName || <span className="dim">— missing —</span>}</td>
                    <td className="small muted">{[row.city, row.state].filter(Boolean).join(', ') || '—'}</td>
                    <td className="small muted">{row.services.join(', ') || '—'}</td>
                    <td className="small muted">
                      {row.contact
                        ? `${row.contact.firstName} ${row.contact.lastName}`.trim() + (row.contact.isMobile ? ' (mobile)' : '')
                        : '—'}
                    </td>
                    <td className="tiny" style={{ color: row.problems.length ? 'var(--warning)' : undefined }}>
                      {row.problems.join('; ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > 50 && <div className="tiny dim mt">Showing the first 50 of {preview.rows.length} rows.</div>}
        </div>
      )}

      {result && (
        <div className="card">
          <div className="card-title">
            <h2>Imported</h2>
          </div>
          <div className="grid grid-4">
            <div className="stat">
              <div className="stat-label">New companies</div>
              <div className="stat-value">{result.companiesCreated}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Updated</div>
              <div className="stat-value">{result.companiesUpdated}</div>
              <div className="stat-sub">already existed by name</div>
            </div>
            <div className="stat">
              <div className="stat-label">Contacts</div>
              <div className="stat-value">{result.contactsCreated}</div>
            </div>
            <div className="stat">
              <div className="stat-label">New capabilities</div>
              <div className="stat-value">{result.capabilitiesCreated}</div>
              <div className="stat-sub">added to the catalogue</div>
            </div>
          </div>

          {result.capabilityMappings.length > 0 && (
            <>
              <div className="divider" />
              <h4>How each service was filed</h4>
              <p className="tiny dim">
                Matching runs on these, not on the text in your file. Anything filed under the wrong capability produces
                no candidates and no error, so it is worth a glance.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>In your file</th>
                      <th>Filed as</th>
                      <th>How</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.capabilityMappings.map((mapping) => (
                      <tr key={`${mapping.service}-${mapping.capability}`}>
                        <td>{mapping.service}</td>
                        <td>{mapping.capability}</td>
                        <td>
                          <span className={`badge${mapping.via === 'created' ? ' accent' : mapping.via === 'inferred' ? ' warning' : ''}`}>
                            {mapping.via === 'exact' ? 'already existed' : mapping.via === 'inferred' ? 'matched by wording' : 'new capability'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {result.warnings.map((warning) => (
            <div className="alert warning small mt" key={warning}>{warning}</div>
          ))}

          <div className="alert info small mt">
            Imported contacts are marked <strong>not consented to SMS</strong> and their numbers are treated as landlines
            unless the column was named mobile or cell. Both are deliberate: a purchased or exported list is not permission
            to text, and texting a landline is billed and silently never arrives.
          </div>
        </div>
      )}
    </>
  );
}
