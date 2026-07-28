/** Tiny DOM helper — the whole "framework". */
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'children'>> & {
    class?: string;
    style?: Partial<CSSStyleDeclaration>;
    dataset?: Record<string, string>;
  } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, style, dataset, ...rest } = props;
  if (cls) node.className = cls;
  if (style) Object.assign(node.style, style);
  if (dataset) Object.assign(node.dataset, dataset);
  Object.assign(node, rest);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

/**
 * "just now" / "4 min ago" — the precision a diagnostic surface benefits from.
 * Shared by the error log and the dashboard, which sit on the same page and
 * must not describe the same timestamp two different ways.
 */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** SVG needs its own namespace — el() creates HTML elements only. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

let toastNode: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, durationMs = 1600): void {
  if (!toastNode) {
    toastNode = el('div', { class: 'toast' });
    document.body.append(toastNode);
  }
  toastNode.textContent = message;
  toastNode.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode?.classList.remove('show'), durationMs);
}
