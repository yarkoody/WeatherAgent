// Print-optimized report: rendered into <body> while printing, then removed (afterprint).
// Print CSS (index.css) hides the app and shows only this; the user saves it as PDF from the print dialog.
import { PrinterIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'

export function ExportReportButton({ report, className }: { report: () => ReactNode; className?: string }) {
  const [content, setContent] = useState<ReactNode>(null)
  useEffect(() => {
    if (!content) return
    const done = () => setContent(null)
    window.addEventListener('afterprint', done)
    window.print()
    return () => window.removeEventListener('afterprint', done)
  }, [content])
  return (
    <>
      <Button variant="ghost" size="xs" className={className ?? 'text-muted-foreground'} onClick={() => setContent(report())}>
        <PrinterIcon />
        Export report
      </Button>
      {content &&
        createPortal(
          <div role="document" aria-label="Printable report" className="print-report">
            {content}
            <footer className="print-footer">
              Hub Weather Risk, {window.location.origin}
              {window.location.pathname === '/' ? '' : window.location.pathname}. Printed {new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.
            </footer>
          </div>,
          document.body,
        )}
    </>
  )
}
