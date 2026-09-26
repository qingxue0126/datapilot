export function ChatBubbleIcon({ className = "" }: { className?: string }) {
  return <svg
    className={`chat-bubble-icon ${className}`.trim()}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20.5 11.2a8.5 8.5 0 0 1-9 8.3 9.7 9.7 0 0 1-2.9-.7L4 21l1.2-4.2a8.5 8.5 0 1 1 15.3-5.6Z" />
  </svg>;
}

export function ServerStackIcon({ className = "" }: { className?: string }) {
  return <svg
    className={`sidebar-nav-icon ${className}`.trim()}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="6" rx="1.5" />
    <rect x="3" y="14" width="18" height="6" rx="1.5" />
    <circle cx="6.5" cy="7" r=".7" fill="currentColor" stroke="none" />
    <circle cx="6.5" cy="17" r=".7" fill="currentColor" stroke="none" />
  </svg>;
}

export function KnowledgeDatabaseIcon({ className = "" }: { className?: string }) {
  return <svg
    className={`sidebar-nav-icon ${className}`.trim()}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <ellipse cx="9.5" cy="5" rx="6.5" ry="2.5" />
    <path d="M3 5v11c0 1.4 2.9 2.5 6.5 2.5 1.4 0 2.7-.2 3.7-.5" />
    <path d="M16 5v6" />
    <path d="M3 10c0 1.4 2.9 2.5 6.5 2.5 2.7 0 5-.6 6-1.5" />
    <path className="knowledge-bolt" d="m19 12-3 5h3l-2 5 5-7h-3l2-3" />
  </svg>;
}
