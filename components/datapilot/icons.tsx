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

export function SmartQaIcon({ className = "" }: { className?: string }) {
  return <svg
    className={`sidebar-nav-icon ${className}`.trim()}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M13.5 5H6a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-7.5" />
    <path d="m10 14 1.2-4.1L18.1 3a2.1 2.1 0 0 1 3 3L14.2 12.9 10 14Z" />
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

export function ModelCubeIcon({ className = "" }: { className?: string }) {
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
    <path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6Z" />
    <path d="m4.4 7.6 7.6 4.3 7.6-4.3M12 12v8.7" />
  </svg>;
}

export function AgentWorkflowIcon({ className = "" }: { className?: string }) {
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
    <path d="M12 3v4M9 3h6" />
    <rect x="5" y="7" width="14" height="12" rx="2.5" />
    <path d="M5 11H3.8A1.8 1.8 0 0 0 2 12.8v1.4A1.8 1.8 0 0 0 3.8 16H5M19 11h1.2a1.8 1.8 0 0 1 1.8 1.8v1.4a1.8 1.8 0 0 1-1.8 1.8H19M9 13h6" />
  </svg>;
}

export function ApiPlugIcon({ className = "" }: { className?: string }) {
  return <svg
    className={`sidebar-nav-icon ${className}`.trim()}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m8.2 15.8-4.4 4.4M15.8 8.2l4.4-4.4" />
    <path d="m6.4 14 3.6 3.6 3.1-3.1-3.6-3.6L6.4 14ZM10.9 9.5l3.6 3.6 3.1-3.1L14 6.4l-3.1 3.1Z" />
  </svg>;
}

export function ConversationLogIcon({ className = "" }: { className?: string }) {
  return <svg className={`sidebar-nav-icon ${className}`.trim()} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3h10l3 3v15H6z" /><path d="M16 3v4h4M9 11h7M9 15h7M9 19h5" /><path d="M3 7h3M3 11h3M3 15h3" />
  </svg>;
}

export function CopyOutputIcon({ className = "" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
}

export function TraceLogIcon({ className = "" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 3h11v18H7z" /><path d="M3 6h4M3 10h4M3 14h4M3 18h4M11 8h4M11 12h4M11 16h3" /></svg>;
}

export function SettingsGearIcon({ className = "" }: { className?: string }) {
  return <svg
    className={`settings-gear-icon ${className}`.trim()}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.3V9.55h.09A1.7 1.7 0 0 0 4.1 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 3.7l.06.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.3h4.05v.09A1.7 1.7 0 0 0 15 4.1a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.5a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.09v4.05h-.09A1.7 1.7 0 0 0 19.4 15Z" />
  </svg>;
}
