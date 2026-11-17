// Print reports (rendered by ExportReportButton). Plain HTML for paper: no glass, no charts, no motion.
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FAMILIES, FAMILY_LABEL, formatDate, formatValue, hubName, pct } from '@/lib/format'
import type { ChatResponse, HubScore } from '@/lib/types'

const STATUS = { pass: 'Numbers verified', retried: 'Verified after retry', failed: 'Unverified' } as const

export function AnswerReport({ response, question, dataAsOf }: { response: ChatResponse; question?: string; dataAsOf?: string }) {
  const a = response.answer
  return (
    <article>
      <h1>Hub Weather Risk: answer report</h1>
      {question && <p className="report-question">Question: {question}</p>}
      <p>
        Validation: <strong>{STATUS[response.grounding.status]}</strong>
        {dataAsOf && <> &nbsp;|&nbsp; Data as of {formatDate(dataAsOf)}</>}
      </p>
      <div className="report-answer">
        <Markdown remarkPlugins={[remarkGfm]} disallowedElements={['img']} unwrapDisallowed>
          {a.answer}
        </Markdown>
      </div>
      {a.figures.length > 0 && (
        <>
          <h2>Figures behind this answer</h2>
          <table>
            <thead>
              <tr>
                <th>Figure</th>
                <th>Hub</th>
                <th>Value</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {a.figures.map((f, i) => (
                <tr key={i}>
                  <td>{f.label}</td>
                  <td>{f.hub_id ? hubName(f.hub_id) : 'General'}</td>
                  <td>{formatValue(f.value, f.unit)}</td>
                  <td>{f.source_tool}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {a.assumptions.length > 0 && (
        <>
          <h2>Assumptions</h2>
          <ul>
            {a.assumptions.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}
      <h2>Data limits</h2>
      <p>{a.uncertainty}</p>
      {response.grounding.status === 'failed' && response.grounding.errors.length > 0 && (
        <>
          <h2>Validation details</h2>
          <ul>
            {response.grounding.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      )}
    </article>
  )
}

export function HubReport({ hub }: { hub: HubScore }) {
  const t = hub.band_thresholds
  const name = hubName(hub.hub_id)
  return (
    <article>
      <h1>{name} risk breakdown</h1>
      <p>Data as of {formatDate(hub.data_as_of)}</p>
      <table>
        <tbody>
          <tr>
            <th>Lost days, typical year</th>
            <td>{hub.exposure_days_per_year}</td>
          </tr>
          {typeof hub.bad_year_days === 'number' && (
            <tr>
              <th>Lost days, worst 1 year in 20</th>
              <td>{hub.bad_year_days}</td>
            </tr>
          )}
          <tr>
            <th>Exposure score</th>
            <td>
              {hub.exposure} ({hub.exposure_band})
            </td>
          </tr>
          <tr>
            <th>Investment priority</th>
            <td>
              {hub.priority} ({hub.priority_band})
            </td>
          </tr>
          <tr>
            <th>Top driver</th>
            <td>{FAMILY_LABEL[hub.top_driver]}</td>
          </tr>
          {typeof hub.hurricane_10yr_probability_pct === 'number' && (
            <tr>
              <th>Hurricane chance, 10 years</th>
              <td>{pct(hub.hurricane_10yr_probability_pct)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <h2>By hazard</h2>
      <table>
        <thead>
          <tr>
            <th>Hazard</th>
            <th>Lost days a year</th>
            <th>In a bad year</th>
            <th>Band</th>
          </tr>
        </thead>
        <tbody>
          {FAMILIES.map((f) => {
            const fam = hub.families[f]
            return (
              <tr key={f}>
                <td>{FAMILY_LABEL[f]}</td>
                <td>{fam?.days_per_year ?? 0}</td>
                <td>{fam?.bad_year_days ?? ''}</td>
                <td>{fam?.band ?? ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {hub.upgrade_categories.length > 0 && <p>Upgrades that help most: {hub.upgrade_categories.join(', ')}.</p>}
      <p className="report-note">
        Score = lost days ÷ {t.days_cap} × 100. Medium from {t.medium_from_days} lost days a year, high from {t.high_from_days}. A hazard is medium from{' '}
        {t.family_medium_from_days} days and high from {t.family_high_from_days}; hurricane is banded by its 10-year chance (medium from {t.hurricane_medium_from_pct}%,
        high from {t.hurricane_high_from_pct}%).
      </p>
    </article>
  )
}
