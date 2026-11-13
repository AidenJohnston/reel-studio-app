import { useEffect, useRef, type ReactNode } from 'react'

/** One setup stage: its heading, one line on why, the content, and a footer with the one action that moves on. */
export function StageShell(props: { title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; testid?: string }) {
  const heading = useRef<HTMLHeadingElement>(null)
  // A new stage replaces the old one, so a screen reader starts reading at its heading.
  useEffect(() => heading.current?.focus({ preventScroll: true }), [])
  return (
    <>
      <h1 ref={heading} tabIndex={-1} className="stage-title" data-testid={props.testid}>
        {props.title}
      </h1>
      {props.description && <p className="stage-desc">{props.description}</p>}
      {props.children && <div className="stage-body">{props.children}</div>}
      {props.footer && <div className="stage-foot">{props.footer}</div>}
    </>
  )
}
