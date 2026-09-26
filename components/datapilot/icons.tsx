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
