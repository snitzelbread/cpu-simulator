/** Render a sentence where `backticks` mark inline code. */
export function renderCode(s: string) {
  return s.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))
}
