import { useEffect, useRef } from 'react'

export default function Modal({ title, onClose, children, footer, wide = false }) {
  const dialogRef = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
      if (!items.length) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKey)
      previousFocus?.focus()
    }
  }, [])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className={`modal tunnel-modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={dialogRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="tunnel-modal-head">
          <div className="modal-title">{title}</div>
          <button className="btn sm ghost" aria-label="关闭弹窗" onClick={onClose}>关闭</button>
        </div>
        <div className="tunnel-modal-body">{children}</div>
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  )
}
