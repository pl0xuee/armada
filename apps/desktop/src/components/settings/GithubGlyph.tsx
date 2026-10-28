/** Simple octocat-free "code host" glyph: a branch inside a rounded square. */
export function GithubGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="9" cy="8.5" r="1.4" />
      <circle cx="9" cy="15.5" r="1.4" />
      <circle cx="15" cy="10" r="1.4" />
      <path d="M9 10v4" />
      <path d="M15 11.4c0 2.2-2.6 2.4-5 3.4" />
    </svg>
  );
}
